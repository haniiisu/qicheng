# -*- coding: utf-8 -*-
"""启程 · 本地服务
静态文件 + 两个 LLM 接口：
  POST /api/translate  公文改写（产出译文卡）
  POST /api/form       表单预填（只返回被允许的字段值 + 核对提示）
  GET  /api/health     引擎状态
仅使用标准库；兼容 OpenAI Chat Completions 协议的任意服务（DeepSeek / 豆包 / 通义 / 星火）。
"""
import html as html_lib
import json
import os
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))


def load_env():
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()
BASE = os.environ.get("LLM_BASE_URL", "").rstrip("/")
KEY = os.environ.get("LLM_API_KEY", "")
MODEL = os.environ.get("LLM_MODEL", "")
CONFIGURED = bool(BASE and KEY and MODEL)

ALLOWED_SOURCES = {"jwc", "xg", "self", "infer", "none"}

# 这些字段绝不允许模型填写：要么来自本人，要么必须由本人补
LOCKED = {
    "申报类别", "社会实践证明编号", "开始时间", "结束时间", "请假事由",
    "去向与联系方式", "家长知情同意书", "是否需车辆接送", "饮食禁忌 / 备注",
    "截止时间", "办理事项", "获奖情况"
}

# 身份与档案字段强制回填，模型不得改动
FIXED = {
    "姓名": ("name", "jwc"),
    "学号": ("sid", "jwc"),
    "学院": ("college", "xg"),
    "专业": ("major", "jwc"),
    "学年平均学分绩点": ("gpa", "jwc"),
    "不及格课程门数": ("failCount", "jwc"),
    "联系电话": ("phone", "self"),
    "手机号": ("phone", "self"),
    "本人联系电话": ("phone", "self"),
    "紧急联系人": ("guardian", "xg"),
    "纪律处分记录": ("discipline", "xg")
}

SPECS = {
    "award": [
        {"label": "姓名"}, {"label": "学号"}, {"label": "学院 / 年级"},
        {"label": "专业"}, {"label": "学年平均学分绩点"}, {"label": "不及格课程门数"},
        {"label": "纪律处分记录"}, {"label": "获奖情况"},
        {"label": "申报类别", "select": ["三好学生", "优秀学生干部", "单项奖"]},
        {"label": "社会实践证明编号"}, {"label": "联系电话"}
    ],
    "leave": [
        {"label": "姓名"}, {"label": "学号"}, {"label": "学院 / 宿舍"},
        {"label": "请假类型", "select": ["事假", "病假", "公假"]},
        {"label": "开始时间"}, {"label": "结束时间"}, {"label": "请假事由"},
        {"label": "去向与联系方式"}, {"label": "家长知情同意书"},
        {"label": "本人联系电话"}, {"label": "紧急联系人"}
    ],
    "activity": [
        {"label": "姓名"}, {"label": "学号"}, {"label": "学院"}, {"label": "手机号"},
        {"label": "是否需车辆接送", "select": ["需要", "不需要"]},
        {"label": "饮食禁忌 / 备注"}
    ],
    "unknown": [
        {"label": "姓名"}, {"label": "学号"}, {"label": "学院"},
        {"label": "办理事项"}, {"label": "截止时间"}, {"label": "联系电话"}
    ]
}

DATE_TOKEN = re.compile(r"(\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*[:：]\s*\d{2})")


def norm(s):
    return re.sub(r"\s+", "", s or "")


def date_tokens(s):
    return [norm(m.group(1)) for m in DATE_TOKEN.finditer(s or "")]


def llm_chat(system, user, timeout=45):
    payload = {
        "model": MODEL,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ]
    }
    req = urllib.request.Request(
        BASE + "/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + KEY
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:300]
        raise RuntimeError("HTTP %s: %s" % (e.code, detail))
    except Exception as e:
        raise RuntimeError(str(e))
    return body["choices"][0]["message"]["content"]


def extract_json(text):
    if not text:
        raise ValueError("空响应")
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("响应中未找到 JSON")
    return json.loads(t[start:end + 1])


TRANSLATE_SYSTEM = (
    "你是东南大学学生事务的公文改写助手。必须严格遵守：\n"
    "1. 只能使用原文中出现的事实，不得新增或改写任何时间、地点、金额、人名、电话、材料名称；\n"
    "2. 不得删去任何条件、例外或时限，不能把「可以」写成「必须」，也不能放宽条件；\n"
    "3. 以学生视角写「要做什么」，动词开头，具体可执行；\n"
    "4. 只输出 JSON，不要 markdown 代码块，不要解释。"
)


def build_translate_prompt(text, ev):
    facts = {
        "类型": ev.get("typeLabel"),
        "标题": ev.get("title"),
        "截止": ev.get("deadlineText"),
        "地点": ev.get("place"),
        "联系人": ev.get("contact"),
        "适用对象": ev.get("audience"),
        "材料": ev.get("materials")
    }
    return (
        "通知原文：\n" + text + "\n\n"
        "已抽取的结构化事实（仅供参照，不得与其冲突）：\n"
        + json.dumps(facts, ensure_ascii=False) + "\n\n"
        "输出格式：\n"
        '{"conclusion":"一句话结论，不超过 55 字，必须含截止时间",'
        '"actions":["3 到 5 条，每条不超过 50 字，动词开头"],'
        '"caveats":["0 到 2 条容易被忽略的限制或例外"]}'
    )


def validate_translate(data, text):
    if not isinstance(data, dict):
        return None, "不是 JSON 对象"
    conclusion = str(data.get("conclusion", "")).strip()
    actions = data.get("actions")
    caveats = data.get("caveats") or []
    if not conclusion or len(conclusion) > 110:
        return None, "结论为空或过长"
    if not isinstance(actions, list) or not (2 <= len(actions) <= 6):
        return None, "行动条数不合规"
    actions = [str(a).strip() for a in actions if str(a).strip()]
    if any(len(a) > 90 for a in actions):
        return None, "行动项过长"
    if not isinstance(caveats, list) or len(caveats) > 3:
        return None, "注意事项不合规"
    caveats = [str(c).strip() for c in caveats if str(c).strip()]

    out = conclusion + "".join(actions) + "".join(caveats)
    src = norm(text)
    for tok in date_tokens(out):
        if tok not in src:
            return None, "出现原文没有的时间：" + tok
    return {
        "conclusion": conclusion,
        "actions": actions,
        "caveats": caveats
    }, None


FORM_SYSTEM = (
    "你是表单预填助手。严格遵守：\n"
    "1. 不确定的字段必须留空，并将 source 写为 none，禁止猜测；\n"
    "2. 姓名、学号、学院、专业、绩点、电话等档案字段必须使用给定档案值，不得改动；\n"
    "3. 只能填写给定清单中的字段，不得增加字段，不得改写通知里的时间与材料；\n"
    "4. 只输出 JSON，不要 markdown，不要解释。"
)


def build_form_prompt(text, ev, profile, ftype):
    spec = SPECS.get(ftype, SPECS["unknown"])
    labels = [s["label"] + ("（可选值：" + "/".join(s["select"]) + "）" if s.get("select") else "") for s in spec]
    return (
        "通知原文：\n" + text + "\n\n"
        "已抽取事实：\n" + json.dumps({
            "类型": ev.get("typeLabel"), "截止": ev.get("deadlineText"),
            "材料": ev.get("materials")
        }, ensure_ascii=False) + "\n\n"
        "学生档案：\n" + json.dumps(profile, ensure_ascii=False) + "\n\n"
        "表单字段清单（只能填这些）：\n" + "\n".join("- " + l for l in labels) + "\n\n"
        "输出格式：\n"
        '{"values":{"字段名":{"value":"填写值，没有则空字符串","source":"jwc|xg|self|infer|none","confidence":0.0}},'
        '"checks":["1 到 3 条提交前必须人工核对的事项，每条不超过 40 字"]}\n'
        "注意：申报类别、证明编号、请假起止时间与事由、同意书等只能由本人提供的字段一律留空。"
    )


def sanitize_values(data, ftype, profile):
    spec = SPECS.get(ftype, SPECS["unknown"])
    given = data.get("values") if isinstance(data, dict) else None
    if not isinstance(given, dict):
        raise ValueError("values 缺失")
    out = {}
    for s in spec:
        label = s["label"]
        item = given.get(label)
        if not isinstance(item, dict):
            continue
        if label in LOCKED:
            continue
        value = str(item.get("value", "")).strip()
        if not value or len(value) > 160:
            continue

        src = str(item.get("source", "infer"))
        if src not in ALLOWED_SOURCES:
            src = "infer"
        try:
            conf = round(float(item.get("confidence", 0.6)), 2)
        except (TypeError, ValueError):
            conf = 0.6
        conf = max(0.0, min(1.0, conf))

        if s.get("select") and value not in s["select"]:
            continue
        if label in FIXED:
            key, fixed_src = FIXED[label]
            if key not in profile:
                continue
            value, src, conf = str(profile[key]), fixed_src, 0.99
        if label == "学院 / 年级":
            value, src = profile.get("college", "") + " · " + profile.get("grade", ""), "xg"
        if label == "学院 / 宿舍":
            value, src = profile.get("college", "") + " · " + profile.get("dorm", ""), "xg"
        out[label] = {"value": value, "source": src, "confidence": conf}
    return out


def clean_checks(data):
    checks = data.get("checks") if isinstance(data, dict) else None
    if not isinstance(checks, list):
        return []
    out = []
    for c in checks[:3]:
        c = str(c).strip()
        if 4 <= len(c) <= 60:
            out.append(c)
    return out


SEU_FEED = "https://seu.wiki/rss"
SEU_TTL = 300
SEU_CACHE = {"at": 0.0, "items": []}


def strip_tags(fragment):
    s = re.sub(r"<br\s*/?>", "\n", fragment)
    s = re.sub(r"</p>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    return html_lib.unescape(s).strip()


def fetch_seu(limit=10):
    now = time.time()
    if SEU_CACHE["items"] and now - SEU_CACHE["at"] < SEU_TTL:
        return SEU_CACHE["items"][:limit], SEU_CACHE["at"]
    req = urllib.request.Request(
        SEU_FEED,
        headers={"User-Agent": "qicheng-prototype/0.1 (+https://seu.wiki/)"}
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read()
    root = ET.fromstring(raw)
    items = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        desc = it.findtext("description") or ""
        if not title or not link:
            continue
        cat = (it.findtext("category") or "").strip()
        author = (it.findtext("author") or "").strip()
        iso = ""
        pub = (it.findtext("pubDate") or "").strip()
        if pub:
            try:
                iso = parsedate_to_datetime(pub).astimezone().isoformat()
            except Exception:
                iso = ""
        href = re.search(r'href="([^"]+)"', desc)
        origin = href.group(1) if href else ""
        paras = []
        for part in re.split(r"</p>", desc):
            txt = strip_tags(part)
            if not txt:
                continue
            if "阅读原文" in txt or "via SEU Wiki" in txt or "seu.wiki/items" in txt:
                continue
            paras.append(txt)
        summary = "\n".join(paras)
        items.append({
            "title": title,
            "url": link,
            "origin": origin,
            "category": cat,
            "author": author,
            "date": iso,
            "summary": summary,
            "text": title + ("\n" + summary if summary else "")
        })
    SEU_CACHE["at"] = now
    SEU_CACHE["items"] = items
    return items[:limit], now


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def end_headers(self):
        path = urlparse(self.path).path
        if path.endswith((".html", ".js", ".css")) or path == "/":
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/health":
            self._json(200, {
                "configured": CONFIGURED,
                "model": MODEL if CONFIGURED else "",
                "base": BASE if CONFIGURED else ""
            })
            return
        if urlparse(self.path).path == "/api/sources/seu":
            qs = parse_qs(urlparse(self.path).query)
            try:
                limit = int(qs.get("limit", ["10"])[0])
            except ValueError:
                limit = 10
            limit = max(1, min(20, limit))
            try:
                items, at = fetch_seu(limit)
                self._json(200, {
                    "ok": True,
                    "source": {"name": "SEU Wiki", "homepage": "https://seu.wiki/", "feed": SEU_FEED},
                    "fetchedAt": int(at * 1000),
                    "items": items
                })
            except Exception as e:
                self._json(502, {"ok": False, "error": "信息源暂不可用：" + str(e)[:160]})
            return
        super().do_GET()

    def do_POST(self):
        if self.path not in ("/api/translate", "/api/form"):
            self._json(404, {"ok": False, "error": "未找到接口"})
            return
        if not CONFIGURED:
            self._json(503, {"ok": False, "error": "未配置模型（缺少 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._json(400, {"ok": False, "error": "请求体不是合法 JSON"})
            return

        text = str(payload.get("text", ""))
        ev = payload.get("extract") or {}
        if len(text.strip()) < 20:
            self._json(400, {"ok": False, "error": "原文过短"})
            return

        try:
            if self.path == "/api/translate":
                content = llm_chat(TRANSLATE_SYSTEM, build_translate_prompt(text, ev))
                data = extract_json(content)
                card, err = validate_translate(data, text)
                if err:
                    self._json(502, {"ok": False, "error": "输出未通过事实校验：" + err})
                    return
                card["engine"] = {"model": MODEL, "mode": "llm"}
                self._json(200, {"ok": True, "card": card})
            else:
                profile = payload.get("profile") or {}
                ftype = payload.get("type") or "unknown"
                content = llm_chat(FORM_SYSTEM, build_form_prompt(text, ev, profile, ftype))
                data = extract_json(content)
                values = sanitize_values(data, ftype, profile)
                if not values:
                    self._json(502, {"ok": False, "error": "模型未返回可用字段，已回退规则引擎"})
                    return
                self._json(200, {
                    "ok": True,
                    "values": values,
                    "checks": clean_checks(data),
                    "engine": {"model": MODEL, "mode": "llm"}
                })
        except Exception as e:
            self._json(502, {"ok": False, "error": str(e)[:240]})


def main():
    port = int(os.environ.get("PORT", "8123"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("启程服务已启动：http://localhost:%d" % port)
    print("模型：%s" % (MODEL + " @ " + BASE if CONFIGURED else "未配置（使用规则引擎）"))
    server.serve_forever()


if __name__ == "__main__":
    main()
