/* 启程 · 交互与编排 */
(function () {
  "use strict";

  const QC = window.QC;
  const $ = function (sel) { return document.querySelector(sel); };
  const STORE_KEY = "qicheng.records.v1";

  const el = {
    samples: $("#samples"),
    notice: $("#notice"),
    charCount: $("#charCount"),
    typeHint: $("#typeHint"),
    run: $("#run"),
    pipeline: $("#pipeline"),
    log: $("#log"),
    tabs: $("#tabs"),
    timer: $("#timer"),
    engineTag: $("#engineTag"),
    sourceList: $("#sourceList"),
    sourceHint: $("#sourceHint"),
    sourceCount: $("#sourceCount"),
    refreshSource: $("#refreshSource"),
    sourceChip: $("#sourceChip"),
    cardEmpty: $("#cardEmpty"),
    cardBody: $("#cardBody"),
    formEmpty: $("#formEmpty"),
    formBody: $("#formBody"),
    archiveBody: $("#archiveBody"),
    search: $("#search"),
    exportAll: $("#exportAll"),
    modal: $("#modal"),
    modalTitle: $("#modalTitle"),
    modalBody: $("#modalBody"),
    printBtn: $("#printBtn"),
    toast: $("#toast")
  };

  const state = {
    extract: null,
    card: null,
    form: null,
    records: loadRecords(),
    startedAt: 0,
    engine: { configured: false, model: "" },
    source: null
  };

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function nowTime() {
    const d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
  }
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.classList.remove("show"); }, 2200);
  }
  function loadRecords() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch (e) { return []; }
  }
  function saveRecords() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.records)); } catch (e) { /* 忽略配额错误 */ }
  }
  function setAgent(name, cls, text) {
    const li = el.pipeline.querySelector('[data-agent="' + name + '"]');
    if (!li) return;
    li.classList.remove("running", "done", "wait");
    if (cls) li.classList.add(cls);
    li.querySelector(".state").textContent = text;
  }
  function log(text, kind) {
    const p = document.createElement("p");
    if (kind) p.className = kind;
    p.textContent = "[" + nowTime() + "] " + text;
    el.log.appendChild(p);
    el.log.scrollTop = el.log.scrollHeight;
  }
  async function api(path, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 40000);
    try {
      const resp = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      const data = await resp.json().catch(function () { return {}; });
      return Object.assign({ httpStatus: resp.status }, data);
    } finally {
      clearTimeout(timer);
    }
  }

  async function initEngine() {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      if (!r.ok) throw new Error("no api");
      const j = await r.json();
      state.engine.configured = !!j.configured;
      state.engine.model = j.model || "";
      if (j.configured) {
        el.engineTag.textContent = "LLM · " + j.model;
        el.engineTag.classList.add("llm");
        el.engineTag.title = "模型服务：" + j.base;
      } else {
        el.engineTag.textContent = "规则引擎（未配置模型）";
        el.engineTag.title = "在 .env 中配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 后重启即可切换";
      }
    } catch (e) {
      el.engineTag.textContent = "规则引擎（离线）";
      el.engineTag.title = "未检测到后端服务，使用本地规则引擎";
    }
  }

  function switchTab(name) {
    el.tabs.querySelectorAll(".tab").forEach(function (b) {
      const on = b.dataset.view === name;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    $("#viewCard").classList.toggle("hidden", name !== "card");
    $("#viewForm").classList.toggle("hidden", name !== "form");
    $("#viewArchive").classList.toggle("hidden", name !== "archive");
    if (name === "archive") renderArchive(el.search.value);
  }

  /* ---------- 初始化 ---------- */
  QC.SAMPLES.forEach(function (s) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = s.label;
    b.addEventListener("click", function () {
      el.notice.value = s.text;
      state.source = null;
      renderSourceChip();
      updateInputMeta();
      el.notice.focus();
    });
    el.samples.appendChild(b);
  });

  function updateInputMeta() {
    const t = el.notice.value;
    el.charCount.textContent = t.replace(/\s/g, "").length;
    el.typeHint.textContent = t.trim() ? QC.TYPE_LABEL[QC.ingest(t).type] : "自动判断";
  }
  el.notice.addEventListener("input", function () {
    updateInputMeta();
    if (state.source && el.notice.value !== state.source.text) {
      state.source = null;
      renderSourceChip();
    }
  });
  el.notice.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runPipeline(); }
  });

  el.tabs.addEventListener("click", function (e) {
    const b = e.target.closest(".tab");
    if (b) switchTab(b.dataset.view);
  });

  el.run.addEventListener("click", runPipeline);

  /* ---------- 信息源：SEU Wiki ---------- */
  function shortDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return (d.getMonth() + 1) + "-" + String(d.getDate()).padStart(2, "0");
  }

  function renderSourceChip() {
    if (!state.source) {
      el.sourceChip.classList.add("hidden");
      el.sourceChip.innerHTML = "";
      return;
    }
    el.sourceChip.classList.remove("hidden");
    el.sourceChip.innerHTML = '<span class="from">来源 · SEU Wiki</span>'
      + "<span>" + esc(state.source.title.length > 26 ? state.source.title.slice(0, 26) + "…" : state.source.title) + "</span>"
      + '<a href="' + esc(state.source.url) + '" target="_blank" rel="noopener">查看条目 ↗</a>'
      + (state.source.origin ? '<a href="' + esc(state.source.origin) + '" target="_blank" rel="noopener">院系原文 ↗</a>' : "");
  }

  function pickSource(item) {
    el.notice.value = item.text;
    state.source = {
      name: "SEU Wiki",
      text: item.text,
      title: item.title,
      url: item.url,
      origin: item.origin
    };
    renderSourceChip();
    updateInputMeta();
    el.notice.focus();
  }

  function renderSourceList(items, fetchedAt) {
    el.sourceCount.textContent = items.length + " 条";
    const fetched = new Date(fetchedAt);
    el.sourceHint.textContent = "SEU Wiki 公开 RSS · "
      + (isNaN(fetched.getTime()) ? "" : shortDate(fetched.toISOString()) + " ")
      + "更新 · 点击载入";
    if (!items.length) {
      el.sourceList.innerHTML = '<li class="empty">信息源暂时没有新条目，可直接粘贴通知。</li>';
      return;
    }
    el.sourceList.innerHTML = items.map(function (it, i) {
      return '<li tabindex="0" role="button" data-src="' + i + '">'
        + '<div class="src-item-title">' + esc(it.title) + "</div>"
        + '<div class="src-item-meta">'
        + (it.category ? '<span class="src-cat">' + esc(it.category) + "</span>" : "")
        + "<span>" + esc((it.author || "").replace(/noreply@seu\.wiki\s*\(?\)?/, "").replace(/[()]/g, "")) + "</span>"
        + "<span>" + shortDate(it.date) + "</span>"
        + (it.origin ? '<a href="' + esc(it.origin) + '" target="_blank" rel="noopener">院系原文 ↗</a>' : "")
        + "</div></li>";
    }).join("");

    el.sourceList.querySelectorAll("[data-src]").forEach(function (li) {
      const item = items[Number(li.dataset.src)];
      li.addEventListener("click", function (e) {
        if (e.target.closest("a")) return;
        pickSource(item);
      });
      li.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pickSource(item);
        }
      });
    });
  }

  async function loadSeu() {
    el.sourceHint.textContent = "正在读取校园公告…";
    el.sourceCount.textContent = "";
    try {
      const r = await fetch("/api/sources/seu?limit=8", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error((j && j.error) || "读取失败");
      renderSourceList(j.items || [], j.fetchedAt || Date.now());
    } catch (e) {
      el.sourceHint.textContent = "信息源暂不可用，可直接粘贴通知";
      el.sourceList.innerHTML = '<li class="empty">' + esc(e.message || String(e))
        + "<br>不影响其余功能，粘贴原文后照常处理。</li>";
    }
  }

  el.refreshSource.addEventListener("click", function (e) {
    e.preventDefault();
    loadSeu();
  });

  /* ---------- 流水线 ---------- */
  async function runPipeline() {
    const text = el.notice.value.trim();
    if (text.length < 40) {
      toast("请先粘贴一条通知，或以示例开始");
      return;
    }

    state.startedAt = performance.now();
    el.run.disabled = true;
    el.run.textContent = "处理中…";
    el.log.innerHTML = "";
    el.timer.textContent = "";
    el.pipeline.querySelectorAll("li").forEach(function (li) {
      li.classList.remove("running", "done", "wait");
      li.querySelector(".state").textContent = "待处理";
    });
    setAgent("archive", null, "待你确认");

    try {
      /* 情报 Agent */
      setAgent("intel", "running", "运行中");
      log("情报 Agent 启动：定位标题、适用对象、截止时间与材料…");
      await sleep(560);
      state.extract = QC.ingest(text);
      state.card = QC.translate(state.extract);
      state.form = QC.buildForm(state.extract);
      setAgent("intel", "done", "完成");
      log("情报 Agent：" + (state.source
        ? "读取 SEU Wiki 条目「" + state.source.title + "」，识别为「" + state.extract.typeLabel + "」，"
        : "识别为「" + state.extract.typeLabel + "」，")
        + "字段平均置信度 " + state.extract.overall.toFixed(2) + "，"
        + (state.extract.deadline ? "截止 " + QC.fmtDeadline(state.extract.deadline) : "未找到明确截止") + "。");

      /* 译官 Agent */
      setAgent("trans", "running", "运行中");
      log("译官 Agent 启动：" + (state.engine.configured
        ? "调用 " + state.engine.model + " 改写，输出将做事实校验…"
        : "未配置模型，使用规则引擎改写…"));
      let llmCard = null;
      if (state.engine.configured) {
        try {
          const res = await api("/api/translate", {
            text: text,
            extract: {
              typeLabel: state.extract.typeLabel,
              title: state.extract.title,
              deadlineText: QC.fmtDeadline(state.extract.deadline),
              place: state.extract.place,
              contact: state.extract.contact,
              audience: state.extract.audience,
              materials: state.extract.materials
            }
          });
          if (res && res.ok && res.card) llmCard = res.card;
          else if (res && res.error) log("译官 Agent：" + res.error + "，已回退规则引擎。", "warn");
        } catch (e) {
          log("译官 Agent：模型接口不可达（" + (e.name || "error") + "），已回退规则引擎。", "warn");
        }
      }
      if (llmCard) {
        state.card = Object.assign(state.card, llmCard, { engine: "llm" });
      } else {
        state.card.engine = "rule";
        await sleep(420);
      }
      setAgent("trans", "done", "完成");
      log("译官 Agent：输出结论 1 条、行动 " + state.card.actions.length + " 步，" +
          (llmCard ? "已通过事实校验（无新增时间与地点）" : "由规则引擎生成，逐句可溯源") + "。",
          llmCard ? "ok" : null);

      /* 表单 Agent */
      setAgent("form", "running", "运行中");
      log("表单 Agent 启动：按字段映射本人档案，标注来源与置信度…");
      let llmForm = null;
      if (state.engine.configured) {
        try {
          const res = await api("/api/form", {
            text: text,
            extract: { typeLabel: state.extract.typeLabel, deadlineText: QC.fmtDeadline(state.extract.deadline), materials: state.extract.materials },
            profile: QC.PROFILE,
            type: state.extract.type
          });
          if (res && res.ok && res.values) llmForm = res;
          else if (res && res.error) log("表单 Agent：" + res.error, "warn");
        } catch (e) {
          log("表单 Agent：模型接口不可达（" + (e.name || "error") + "），已回退规则引擎。", "warn");
        }
      }
      if (llmForm) {
        let applied = 0;
        state.form.rows.forEach(function (r) {
          const v = llmForm.values[r.label];
          if (v && typeof v.value === "string" && v.value) {
            r.value = v.value;
            r.source = v.source || "infer";
            r.conf = typeof v.confidence === "number" ? v.confidence : r.conf;
            applied += 1;
          }
        });
        state.form.checks = llmForm.checks || [];
        state.form.missing = state.form.rows.filter(function (r) { return !r.value; }).length;
        state.form.requiredMissing = state.form.rows.filter(function (r) { return r.required && !r.value; }).length;
        log("表单 Agent：模型回填 " + applied + " 个字段，身份字段按档案锁定，" +
            state.form.missing + " 项仍需本人补充。", state.form.missing ? "warn" : "ok");
      } else {
        await sleep(460);
        log("表单 Agent：生成 " + state.form.rows.length + " 个字段，其中 " + state.form.missing +
            " 项无法自动获取，已高亮留空。", state.form.missing ? "warn" : "ok");
      }
      setAgent("form", "done", "完成");

      const cost = ((performance.now() - state.startedAt) / 1000).toFixed(1);
      el.timer.textContent = "本次处理 " + cost + " 秒 · 人工核对约 1 分钟";

      renderCard();
      renderForm();
      switchTab("card");
    } finally {
      el.run.disabled = false;
      el.run.textContent = "开始处理";
    }
  }

  /* ---------- 译文卡 ---------- */
  function renderCard() {
    const ev = state.extract, card = state.card;
    const ds = QC.deadlineState(ev.deadline);

    let html = "";
    html += '<div class="card-top">'
      + '<span class="tag">' + esc(ev.typeLabel) + '</span>'
      + '<span class="tag ' + ((ds.level === "urgent" || ds.level === "over") ? "amber" : ds.level === "unknown" ? "grey" : "green") + '">' + esc(ds.text) + '</span>'
      + '<span class="tag ' + (card.engine === "llm" ? "green" : "grey") + '">'
      + (card.engine === "llm" ? esc(state.engine.model) + " 改写 · 已校验" : "规则引擎改写") + '</span>'
      + '<span class="tag grey">原文 ' + ev.charCount + " 字 → 译文 " + (card.conclusion.length + card.actions.join("").length) + " 字</span>"
      + (state.source ? '<a class="tag grey link" href="' + esc(state.source.url) + '" target="_blank" rel="noopener">来源 SEU Wiki ↗</a>' : "")
      + "</div>";
    html += '<h3 class="card-title">' + esc(ev.title) + "</h3>";
    html += '<div class="conclusion">' + esc(card.conclusion) + "</div>";

    html += '<div class="block"><h4>我要做什么</h4><ul class="actions" id="actionList">';
    card.actions.forEach(function (a) {
      html += '<li><span class="box">✓</span><span>' + esc(a) + "</span></li>";
    });
    html += "</ul></div>";

    html += '<div class="block"><h4>关键信息</h4><div class="kv-grid">'
      + kv("截止时间", card.deadlineText)
      + kv("地点", card.place)
      + kv("找谁", card.contactText, true)
      + kv("适用对象", card.audience, true)
      + "</div></div>";

    html += '<div class="block"><h4>材料清单</h4>';
    if (ev.materials.length) {
      html += '<div class="materials">' + ev.materials.map(function (m) {
        return '<span class="mat">' + esc(m) + "</span>";
      }).join("") + "</div>";
    } else {
      html += '<p class="hint">原文未明确列出材料，建议向发文单位确认。</p>';
    }
    html += "</div>";

    if (card.caveats && card.caveats.length) {
      html += '<div class="block"><h4>需要留意</h4><ul class="actions">';
      card.caveats.forEach(function (c) {
        html += '<li><span class="box" style="border-color:#e8c98f;color:#b26a00">!</span><span style="text-decoration:none">' + esc(c) + "</span></li>";
      });
      html += "</ul></div>";
    }

    html += '<details class="origin"><summary>原文对照（黄色为被引用的句子）</summary>'
      + '<div class="origin-body">' + highlight(el.notice.value.trim(), ev) + "</div></details>";

    html += '<div class="card-foot"><span>译官不改动条件与时间；括号内为原文原话。</span>'
      + '<button class="ghost" id="toForm" type="button">去看草表 →</button></div>';

    el.cardBody.innerHTML = html;
    el.cardEmpty.classList.add("hidden");
    el.cardBody.classList.remove("hidden");

    el.cardBody.querySelectorAll("#actionList li").forEach(function (li) {
      li.addEventListener("click", function () { li.classList.toggle("done"); });
    });
    const toForm = el.cardBody.querySelector("#toForm");
    if (toForm) toForm.addEventListener("click", function () { switchTab("form"); });
  }

  function kv(k, v, small) {
    return '<div class="kv"><div class="k">' + esc(k) + '</div><div class="v' + (small ? " small" : "") + '">' + esc(v) + "</div></div>";
  }

  function highlight(text, ev) {
    const marks = [];
    if (ev.deadline) marks.push(ev.deadline.raw);
    if (ev.contact && ev.contact.name) marks.push(ev.contact.name);
    if (ev.place) marks.push(ev.place);
    if (ev.audience) marks.push(ev.audience);
    ["申报表", "成绩单", "获奖证书", "社会实践证明", "家长知情同意书", "交至", "扫码报名", "销假", "逾期"].forEach(function (k) {
      if (text.indexOf(k) !== -1) marks.push(k);
    });

    return text.split("\n").map(function (line) {
      let html = esc(line);
      marks.forEach(function (m) {
        if (!m) return;
        const e = esc(m);
        html = html.split(e).join("@@MARK@@" + e + "@@END@@");
      });
      html = html.replace(/@@MARK@@/g, "<mark>").replace(/@@END@@/g, "</mark>");
      return html;
    }).join("<br>");
  }

  /* ---------- 草表 ---------- */
  function renderForm() {
    const f = state.form;
    let html = '<div class="form-head"><span class="tag green">草稿</span>'
      + '<span class="form-name">' + esc(f.name) + "</span></div>"
      + '<p class="form-note">' + esc(f.note) + " 共 " + f.rows.length + " 个字段。</p>";

    if (f.missing) {
      html += '<div class="miss-bar">⚠ <span>有 <b>' + f.missing + " 项</b>无法从系统获取，需要你补充。启程不会猜测缺失内容。</span></div>";
    }

    html += '<table class="sheet"><thead><tr><th>字段</th><th>内容</th><th>来源</th><th>置信度</th></tr></thead><tbody>';
    f.rows.forEach(function (r, i) {
      const missing = !r.value;
      html += '<tr class="' + (missing ? "missing" : "") + '" data-row="' + i + '">';
      html += '<td class="label">' + esc(r.label) + (r.required ? ' <span style="color:#b26a00">*</span>' : "") + "</td>";
      html += '<td class="value">';
      if (missing) {
        if (r.input === "select") {
          html += '<select data-input="' + i + '"><option value="">请选择…</option>' +
            (r.options || []).map(function (o) { return "<option>" + esc(o) + "</option>"; }).join("") + "</select>";
        } else {
          html += '<input type="text" data-input="' + i + '" placeholder="' + esc(r.hint || "请补充") + '">';
        }
      } else {
        html += esc(r.value);
      }
      html += '<span class="srcbadge src-' + r.source + ' src-inline">' + esc(QC.SOURCE_LABEL[r.source]) + "</span>";
      html += "</td>";
      html += '<td class="src"><span class="srcbadge src-' + r.source + '">' + esc(QC.SOURCE_LABEL[r.source]) + "</span></td>";
      html += '<td class="conf">' + confBar(r.conf) + "</td>";
      html += "</tr>";
    });
    html += "</tbody></table>";

    if (f.checks && f.checks.length) {
      html += '<div class="checks"><h4>模型给出的核对提示（供参考，不替代你的判断）</h4><ul>'
        + f.checks.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul></div>";
    }

    html += '<div class="confirm-box">'
      + '<label><input type="checkbox" id="ack"><span>我已逐项核对以上内容，确认来源与数值无误；我知悉签名、盖章与提交仍由本人完成。</span></label>'
      + '<div class="confirm-actions">'
      + '<button class="primary" id="confirmBtn" type="button" disabled>确认并生成草表</button>'
      + '<button class="ghost" id="backCard" type="button">返回译文卡</button>'
      + '<span class="card-foot" style="border:0;padding:0;margin:0;font-size:11px" id="readyHint">还有 ' + f.missing + " 项待补充</span>"
      + "</div></div>";

    el.formBody.innerHTML = html;
    el.formEmpty.classList.add("hidden");
    el.formBody.classList.remove("hidden");

    const ack = $("#ack");
    const btn = $("#confirmBtn");
    const hint = $("#readyHint");

    function refresh() {
      const filled = f.rows.every(function (r) { return !r.required || r.value; });
      const missingLeft = f.rows.filter(function (r) { return !r.value; }).length;
      btn.disabled = !(ack.checked && filled);
      if (!missingLeft && ack.checked) hint.textContent = "可以生成";
      else if (!missingLeft) hint.textContent = "勾选左侧确认项后可生成";
      else hint.textContent = "还有 " + missingLeft + " 项待补充";
    }

    el.formBody.querySelectorAll("[data-input]").forEach(function (input) {
      const i = Number(input.dataset.input);
      const handler = function () {
        f.rows[i].value = input.value.trim();
        f.rows[i].source = input.value.trim() ? "self" : "none";
        f.rows[i].conf = input.value.trim() ? 0.99 : 0;
        const tr = el.formBody.querySelector('[data-row="' + i + '"]');
        if (tr) {
          tr.classList.toggle("missing", !f.rows[i].value);
          const inline = tr.querySelector(".src-inline");
          if (inline) {
            inline.className = "srcbadge src-" + f.rows[i].source + " src-inline";
            inline.textContent = QC.SOURCE_LABEL[f.rows[i].source];
          }
        }
        refresh();
      };
      input.addEventListener("input", handler);
      input.addEventListener("change", handler);
    });
    ack.addEventListener("change", refresh);
    btn.addEventListener("click", confirmForm);
    $("#backCard").addEventListener("click", function () { switchTab("card"); });
    refresh();
  }

  function confBar(v) {
    if (!v) return '<span class="confnum">—</span>';
    const cls = v < 0.75 ? "low" : "";
    return '<span class="confbar"><i class="' + cls + '" style="width:' + Math.round(v * 100) + '%"></i></span>'
      + '<span class="confnum">' + v.toFixed(2) + "</span>";
  }

  /* ---------- 确认与归档 ---------- */
  function confirmForm() {
    const f = state.form, ev = state.extract;
    const record = {
      id: "QC" + Date.now().toString().slice(-8),
      type: ev.type,
      typeLabel: ev.typeLabel,
      title: ev.title,
      deadlineText: state.card.deadlineText,
      deadline: ev.deadline ? ev.deadline.iso : "",
      formName: f.name,
      rows: f.rows.map(function (r) {
        return { label: r.label, value: r.value, source: r.source, conf: r.conf };
      }),
      createdAt: new Date().toISOString(),
      status: "草表已生成，待本人提交",
      source: state.source ? { name: state.source.name, title: state.source.title, url: state.source.url } : null
    };

    state.records.unshift(record);
    saveRecords();

    setAgent("archive", "done", "已归档");
    log("归档 Agent：草表已归档（" + record.id + "），明年同类通知可直接复用。", "ok");

    openModal(record, true);
    el.timer.textContent = el.timer.textContent + " · 已归档";
    switchTab("archive");
  }

  function openModal(record, isNew) {
    el.modalTitle.textContent = isNew ? "草表已生成 · " + record.id : record.formName;
    let html = '<div class="paper">'
      + "<h4>" + esc(record.formName.replace("（草表）", "")) + "</h4>"
      + '<div class="paper-sub">草表编号 ' + esc(record.id) + " · 生成于 " + new Date(record.createdAt).toLocaleString("zh-CN") + "</div>"
      + "<table>";
    record.rows.forEach(function (r) {
      html += '<tr><td class="k">' + esc(r.label) + '</td><td class="v">' + esc(r.value || "（待补充）") + "</td></tr>";
    });
    html += "</table>";
    html += '<div class="paper-sign"><span>本人签字：____________</span><span>日期：____ 年 __ 月 __ 日</span></div>';
    html += '<div class="paper-sign" style="color:#b26a00"><span>本页为草表，提交前请核对并签字。</span><span>' + esc(record.status) + "</span></div>";
    html += "</div>";
    el.modalBody.innerHTML = html;
    el.modal.classList.remove("hidden");
  }

  function closeModal() { el.modal.classList.add("hidden"); }
  el.modal.querySelectorAll("[data-close]").forEach(function (n) {
    n.addEventListener("click", closeModal);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !el.modal.classList.contains("hidden")) closeModal();
  });
  el.printBtn.addEventListener("click", function () { window.print(); });

  /* ---------- 归档视图 ---------- */
  function renderArchive(q) {
    q = (q || "").trim().toLowerCase();
    const list = state.records.filter(function (r) {
      if (!q) return true;
      return (r.title + r.typeLabel + r.deadlineText + r.formName).toLowerCase().indexOf(q) !== -1;
    });

    if (!state.records.length) {
      el.archiveBody.innerHTML = '<div class="rec-empty">还没有归档记录。<br>处理一条通知并确认草表后，它会自动出现在这里。</div>';
      return;
    }
    if (!list.length) {
      el.archiveBody.innerHTML = '<div class="rec-empty">没有匹配「' + esc(q) + "」的记录。</div>";
      return;
    }

    el.archiveBody.innerHTML = list.map(function (r) {
      const d = new Date(r.createdAt);
      const time = d.getMonth() + 1 + " 月 " + d.getDate() + " 日 " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      return '<div class="rec">'
        + '<div class="rec-top"><span class="tag">' + esc(r.typeLabel) + "</span>"
        + '<span class="rec-title">' + esc(r.title) + "</span>"
        + '<span class="rec-actions"><button class="ghost" data-view-rec="' + esc(r.id) + '" type="button">查看草表</button></span></div>'
        + '<div class="rec-meta"><span>截止 ' + esc(r.deadlineText) + "</span><span>归档 " + time + "</span>"
        + "<span>" + esc(r.status) + "</span><span>编号 " + esc(r.id) + "</span>"
        + (r.source ? '<a href="' + esc(r.source.url) + '" target="_blank" rel="noopener" style="color:#2b5c8f">来源 ' + esc(r.source.name) + " ↗</a>" : "")
        + "</div>"
        + "</div>";
    }).join("");

    el.archiveBody.querySelectorAll("[data-view-rec]").forEach(function (b) {
      b.addEventListener("click", function () {
        const rec = state.records.find(function (r) { return r.id === b.dataset.viewRec; });
        if (rec) openModal(rec, false);
      });
    });
  }

  el.search.addEventListener("input", function () { renderArchive(el.search.value); });

  el.exportAll.addEventListener("click", function () {
    if (!state.records.length) { toast("还没有可导出的记录"); return; }
    const blob = new Blob([JSON.stringify(state.records, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "启程-我的事务-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("已导出 " + state.records.length + " 条记录");
  });

  /* ---------- 启动 ---------- */
  updateInputMeta();
  initEngine();
  loadSeu();
  renderArchive("");
})();
