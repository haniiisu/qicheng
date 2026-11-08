/* 启程 · 智能体实现（本地规则版）
 * 四个 Agent：情报抽取 / 公文改写 / 表单映射 / 归档。
 * 演示版不调用外部大模型，所有判断均可复现、可核查。
 */
window.QC = (function () {
  "use strict";

  const PROFILE = {
    name: "张知远",
    sid: "2026A0312",
    college: "信息科学与工程学院",
    major: "信息工程",
    grade: "2026 级",
    gpa: "3.42",
    failCount: "0",
    discipline: "无纪律处分记录",
    awards: "2026 年校数学竞赛二等奖；军训优秀学员",
    practice: "2026 年暑期社会实践（南京）",
    phone: "138****6621",
    dorm: "桃园 5 舍 312",
    bank: "6222 **** **** 1189",
    guardian: "父亲 138****3092"
  };

  const SOURCE_LABEL = {
    jwc: "教务系统",
    xg: "学工系统",
    self: "本人填写",
    infer: "AI 推断",
    none: "无法获取"
  };

  const TYPE_LABEL = {
    award: "评奖评优",
    leave: "请假销假",
    activity: "活动报名",
    reimburse: "报销",
    unknown: "通用事务"
  };

  const SAMPLES = [
    {
      label: "评奖评优通知",
      type: "award",
      text:
        "关于开展 2026—2027 学年本科生评奖评优工作的通知\n" +
        "各书院、各位同学：\n" +
        "为做好本学年本科生评奖评优工作，现将有关事项通知如下：\n" +
        "一、评选范围：2026 级全体本科在校生（含转专业学生）。\n" +
        "二、评选条件：学年平均学分绩点不低于 3.0，无不及格课程，未受过纪律处分；申报「三好学生」须另附社会实践证明。\n" +
        "三、材料要求：请于 11 月 8 日 17:00 前将《本科生评奖评优申报表》一式两份、成绩单复印件、获奖证书复印件交至所在书院学生工作办公室（九龙湖校区文科楼 B203）。\n" +
        "四、其他：逾期不予受理。联系人：王老师，电话 025-52091234，邮箱 xgb@seu.edu.cn。"
    },
    {
      label: "请假管理通知",
      type: "leave",
      text:
        "关于国庆假期前后学生请假管理的通知\n" +
        "各位同学：\n" +
        "为保障假期前后教学秩序，现就请假事项通知如下：\n" +
        "一、离校须于 9 月 28 日 18:00 前在「学工系统」提交请假申请，并附家长知情同意书，经辅导员审批后方可离校。\n" +
        "二、请假三天以上须由书院分管领导复核；未经审批擅自离校的，按校纪校规处理。\n" +
        "三、返校后 24 小时内须在系统内销假，逾期未销假视为旷课。\n" +
        "联系人：李老师，电话 025-52095678。"
    },
    {
      label: "活动报名通知",
      type: "activity",
      text:
        "关于举办「书院文化节 · 新生之夜」活动的通知\n" +
        "各书院新生：\n" +
        "为丰富新生校园文化生活，定于 10 月 30 日 19:00 在九龙湖校区焦廷标馆举办「书院文化节 · 新生之夜」活动。\n" +
        "一、参加对象：2026 级全体本科新生。\n" +
        "二、报名方式：请于 10 月 28 日 18:00 前扫码报名，限 200 人，额满即止。\n" +
        "三、注意事项：活动当天请提前 15 分钟入场签到；需统一乘车前往的同学，请在报名时勾选「需要车辆接送」。\n" +
        "联系人：陈同学，电话 025-52098888。"
    }
  ];

  /* ---------- 情报 Agent ---------- */
  function detectType(text) {
    if (/评奖评优|奖学金|奖助|推优|入党积极分子|三好学生|优秀学生干部/.test(text)) return "award";
    if (/请假|销假|离校|返校/.test(text)) return "leave";
    if (/报名|活动|讲座|晚会|文化节/.test(text)) return "activity";
    if (/报销|发票|差旅|经费/.test(text)) return "reimburse";
    return "unknown";
  }

  function sentences(text) {
    return text.split(/(?<=[。；\n])/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function findDeadline(text) {
    const re = /(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(上午|下午)?\s*(\d{1,2})\s*[:：]\s*(\d{2}))?/g;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const ctx = text.slice(Math.max(0, m.index - 34), m.index + m[0].length + 16);
      const pre = text.slice(Math.max(0, m.index - 8), m.index);
      let score = 0;
      if (/截止|不予受理|逾期|额满/.test(ctx)) score += 3;
      if (/前/.test(ctx)) score += 1;
      if (/提交|交至|报送|申报|报名|申请|材料|上交/.test(ctx)) score += 2;
      if (/请于|须于|应于|务必于|需于/.test(pre)) score += 2;
      if (/不晚于|不得晚于/.test(ctx)) score -= 3;
      else if (/条件|资格|须|要求/.test(ctx)) score -= 1;
      let hour = m[4] ? Number(m[4]) : null;
      if (hour !== null && m[3] === "下午" && hour < 12) hour += 12;
      out.push({
        raw: m[0].replace(/\s+/g, ""),
        month: Number(m[1]),
        day: Number(m[2]),
        hour: hour,
        minute: m[5] ? Number(m[5]) : null,
        urgent: score > 0,
        score: score,
        index: m.index
      });
    }
    if (!out.length) return null;
    out.sort(function (a, b) { return (b.score - a.score) || (a.index - b.index); });
    const d = out[0];
    if (d.score <= 0) return null;   // 只有条件性日期时，不把条件冒充截止时间
    const year = new Date().getFullYear();
    d.iso = year + "-" + String(d.month).padStart(2, "0") + "-" + String(d.day).padStart(2, "0");
    d.hm = d.hour === null ? "" : String(d.hour).padStart(2, "0") + ":" + String(d.minute).padStart(2, "0");
    return d;
  }

  function fmtDeadline(d) {
    if (!d) return "以原文为准";
    return d.month + " 月 " + d.day + " 日" + (d.hm ? " " + d.hm : "");
  }

  function findPlace(text) {
    const m = text.match(/(九龙湖|四牌楼|丁家桥|苏州)[^，。；\n)）]{0,18}/);
    return m ? m[0].replace(/[）)\s]+$/, "").trim() : "";
  }

  function findContact(text) {
    const name = text.match(/联系人[：:]\s*([\u4e00-\u9fa5]{2,4}(?:老师|同学|主任|处)?)/);
    const phone = text.match(/(?:0\d{2,3}[-\s]?\d{7,8}|1\d{10})/);
    const mail = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
    return {
      name: name ? name[1] : "",
      phone: phone ? phone[0] : "",
      mail: mail ? mail[0] : ""
    };
  }

  function findAudience(text) {
    const m = text.match(/(?:评选范围|参加对象|参与对象|面向)[：:]\s*([^。；\n]+)/);
    return m ? m[1].trim() : "";
  }

  function findMaterials(text) {
    const hits = sentences(text).filter(function (s) {
      return /材料|一式|复印件|交至|附|提交|上传|原件/.test(s);
    });
    const items = [];
    const keys = [
      ["申报表", "《本科生评奖评优申报表》一式两份"],
      ["成绩单", "成绩单复印件"],
      ["获奖证书", "获奖证书复印件"],
      ["社会实践证明", "社会实践证明"],
      ["家长知情同意书", "家长知情同意书"],
      ["请假申请", "学工系统请假申请"],
      ["报名信息", "报名信息（扫码填写）"]
    ];
    keys.forEach(function (k) {
      if (text.indexOf(k[0]) !== -1) items.push(k[1]);
    });
    return { items: items, source: hits };
  }

  function ingest(text) {
    const type = detectType(text);
    const firstLine = text.split(/\n/)[0].trim();
    const deadline = findDeadline(text);
    const contact = findContact(text);
    const place = findPlace(text);
    const audience = findAudience(text);
    const materials = findMaterials(text);

    const fields = {
      type: 1,
      title: firstLine ? 1 : 0,
      deadline: deadline ? (deadline.urgent ? 0.95 : 0.82) : 0,
      place: place ? 0.86 : 0,
      contact: contact.name ? (contact.phone ? 0.93 : 0.74) : 0,
      audience: audience ? 0.9 : 0,
      materials: materials.items.length ? 0.88 : 0
    };
    const vals = Object.keys(fields).map(function (k) { return fields[k]; });
    const overall = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;

    return {
      type: type,
      typeLabel: TYPE_LABEL[type],
      title: firstLine || "未识别标题",
      deadline: deadline,
      place: place,
      contact: contact,
      audience: audience,
      materials: materials.items,
      evidence: materials.source,
      confidence: fields,
      overall: overall,
      charCount: text.replace(/\s/g, "").length
    };
  }

  /* ---------- 译官 Agent ---------- */
  function translate(ev) {
    const dl = fmtDeadline(ev.deadline);
    let conclusion, actions, caveats;

    if (ev.type === "award") {
      conclusion = ev.deadline
        ? "本学年评奖评优开始申报，" + dl + " 截止，逾期不予受理。"
        : "本学年评奖评优开始申报，原文未写明确切截止时间，请以院系原文为准。";
      actions = [
        "对照条件自查：学年绩点不低于 3.0、无不及格课程、无纪律处分",
        "备齐三样材料：申报表一式两份、成绩单复印件、获奖证书复印件",
        "在截止前交到" + (ev.place || "书院学生工作办公室") + "，现场登记",
        "确认是否申报「三好学生」——该类别另需社会实践证明"
      ];
      caveats = ["「三好学生」与「优秀学生干部」不可同时兼报，以书院最终口径为准。"];
    } else if (ev.type === "leave") {
      conclusion = ev.deadline
        ? "离校须在 " + dl + " 前完成线上请假审批，返校 24 小时内销假。"
        : "离校请假须先在「学工系统」提交并审批，原文未写明确切时间。";
      actions = [
        "在「学工系统」提交请假申请，不要只口头告知辅导员",
        "上传家长知情同意书，写明离校与返校时间",
        "请假超过三天，需辅导员与书院分管领导双重审批",
        "返校后 24 小时内销假，逾期按旷课处理"
      ];
      caveats = ["未经审批擅自离校按校纪校规处理，不要先走后补。"];
    } else if (ev.type === "activity") {
      conclusion = ev.deadline
        ? "活动 " + dl.replace("前", "") + " 前报名，名额有限、额满即止。"
        : "活动已开放报名，原文未写明确切截止时间，建议尽快报名。";
      actions = [
        "在截止前扫码报名，注意限 200 人",
        "记下活动时间与地点，加入日历提醒",
        "需要统一乘车前往的，报名时勾选「需要车辆接送」",
        "当天提前 15 分钟入场签到"
      ];
      caveats = ["报名成功不等于有座位，建议提前到场。"];
    } else {
      conclusion = "这是一条事务类通知，关键时间与材料见下方清单。";
      actions = [
        "确认通知的适用对象是否包含你",
        "按材料清单准备，注意份数与是否需复印件",
        "在截止时间前完成提交，并保留回执",
        "有疑问直接联系发文单位，不以群内传言为准"
      ];
      caveats = ["通知类型未能自动判断，请以原文为准。"];
    }

    return {
      conclusion: conclusion,
      actions: actions,
      caveats: caveats,
      deadlineText: dl,
      place: ev.place || "详见原文",
      contactText: ev.contact.name
        ? ev.contact.name + (ev.contact.phone ? " · " + ev.contact.phone : "") + (ev.contact.mail ? " · " + ev.contact.mail : "")
        : "原文未注明",
      audience: ev.audience || "原文未注明"
    };
  }

  /* ---------- 表单 Agent ---------- */
  function row(label, value, source, conf, opt) {
    return Object.assign({
      label: label,
      value: value || "",
      source: source,
      conf: conf,
      input: "text"
    }, opt || {});
  }

  function buildForm(ev) {
    let name, note, rows;

    if (ev.type === "award") {
      name = "本科生评奖评优申报表（草表）";
      note = "字段来自教务系统与学工系统；取不到的一律留空，不做推测。";
      rows = [
        row("姓名", PROFILE.name, "jwc", 0.99),
        row("学号", PROFILE.sid, "jwc", 0.99),
        row("学院 / 年级", PROFILE.college + " · " + PROFILE.grade, "xg", 0.98),
        row("专业", PROFILE.major, "jwc", 0.97),
        row("学年平均学分绩点", PROFILE.gpa, "jwc", 0.96),
        row("不及格课程门数", PROFILE.failCount, "jwc", 0.95),
        row("纪律处分记录", PROFILE.discipline, "xg", 0.9),
        row("获奖情况", PROFILE.awards, "xg", 0.88, { input: "textarea" }),
        row("申报类别", "", "none", 0, {
          required: true, input: "select", options: ["三好学生", "优秀学生干部", "单项奖"],
          hint: "系统中无此字段，请本人选择；三好学生需另附实践证明"
        }),
        row("社会实践证明编号", "", "none", 0, {
          required: true, hint: "申报三好学生时必填，填写证明编号或上传照片"
        }),
        row("联系电话", PROFILE.phone, "self", 0.99)
      ];
    } else if (ev.type === "leave") {
      name = "学生请假申请单（草表）";
      note = "起止时间按通知推断填写，请按实际行程修改。";
      rows = [
        row("姓名", PROFILE.name, "xg", 0.99),
        row("学号", PROFILE.sid, "xg", 0.99),
        row("学院 / 宿舍", PROFILE.college + " · " + PROFILE.dorm, "xg", 0.96),
        row("请假类型", "事假", "infer", 0.62, { input: "select", options: ["事假", "病假", "公假"] }),
        row("开始时间", "", "infer", 0, { required: true, hint: "按车票或行程填写，格式 2026-09-28 18:00" }),
        row("结束时间", "", "infer", 0, { required: true, hint: "返校时间须在销假时限内" }),
        row("请假事由", "", "self", 0, { required: true }),
        row("去向与联系方式", "", "self", 0, { required: true }),
        row("家长知情同意书", "", "none", 0, { required: true, hint: "填写已上传的文件名，或注明纸质件已交辅导员" }),
        row("本人联系电话", PROFILE.phone, "self", 0.99),
        row("紧急联系人", PROFILE.guardian, "xg", 0.9)
      ];
    } else if (ev.type === "activity") {
      name = "「新生之夜」活动报名表（草表）";
      note = "报名信息直接取自学工系统，勾选项需本人确认。";
      rows = [
        row("姓名", PROFILE.name, "xg", 0.99),
        row("学号", PROFILE.sid, "xg", 0.99),
        row("学院", PROFILE.college, "xg", 0.98),
        row("手机号", PROFILE.phone, "self", 0.99),
        row("是否需车辆接送", "", "none", 0, {
          required: true, input: "select", options: ["需要", "不需要"], hint: "通知要求报名时勾选"
        }),
        row("饮食禁忌 / 备注", "", "none", 0, { hint: "选填，便于现场安排" })
      ];
    } else {
      name = "事务办理草表（通用）";
      note = "通知类型未能识别，仅生成基础信息表。";
      rows = [
        row("姓名", PROFILE.name, "jwc", 0.99),
        row("学号", PROFILE.sid, "jwc", 0.99),
        row("学院", PROFILE.college, "xg", 0.98),
        row("办理事项", ev.title, "infer", 0.7),
        row("截止时间", fmtDeadline(ev.deadline), "infer", ev.deadline ? 0.86 : 0, { required: !ev.deadline }),
        row("联系电话", PROFILE.phone, "self", 0.99)
      ];
    }

    const missing = rows.filter(function (r) { return !r.value; });
    return {
      name: name,
      note: note,
      rows: rows,
      missing: missing.length,
      requiredMissing: rows.filter(function (r) { return r.required && !r.value; }).length
    };
  }

  function deadlineState(d) {
    if (!d) return { level: "unknown", text: "以原文为准" };
    const now = new Date();
    const target = new Date(d.iso + "T" + (d.hm || "23:59") + ":00");
    const diff = target - now;
    const days = Math.ceil(diff / 86400000);
    if (diff < 0) return { level: "over", text: "已截止" };
    if (days <= 2) return { level: "urgent", text: "剩 " + Math.max(1, days) + " 天" };
    return { level: "ok", text: "剩 " + days + " 天" };
  }

  return {
    PROFILE: PROFILE,
    SAMPLES: SAMPLES,
    SOURCE_LABEL: SOURCE_LABEL,
    TYPE_LABEL: TYPE_LABEL,
    ingest: ingest,
    translate: translate,
    buildForm: buildForm,
    fmtDeadline: fmtDeadline,
    deadlineState: deadlineState,
    sentences: sentences
  };
})();
