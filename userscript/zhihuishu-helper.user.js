// ==UserScript==
// @name         智慧树 AI 答题助手
// @namespace    https://scriptcat.org/
// @version      1.3.1
// @description  一个脚本覆盖两个页面：共享课作业(stuExamWeb)抓包解析题目 + 翻转课作业(atHomeworkExam)遍历抓取题目，均附带提示词交由后台 DeepSeek 获取答案 JSON 并自动作答
// @author       jjj
// @match        *://onlineexamh5new.zhihuishu.com/stuExamWeb.html*
// @match        *://*.hiexam.zhihuishu.com/atHomeworkExam/*
// @match        https://chat.deepseek.com/*
// @grant        unsafeWindow
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @homepageURL  https://github.com/feng161110/zhihuishu-desktop
// @supportURL   https://github.com/feng161110/zhihuishu-desktop/issues
// @updateURL    https://cdn.jsdelivr.net/gh/feng161110/zhihuishu-desktop@main/userscript/zhihuishu-helper.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/feng161110/zhihuishu-desktop@main/userscript/zhihuishu-helper.user.js
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    /* ================== 公共配置 ================== */
    const CONFIG = {
        deepseekUrl: 'https://chat.deepseek.com/',
        workerName: 'ds_homework_worker',
        heartbeatInterval: 5000,
        heartbeatStale: 90000,            // 后台标签页定时器会被节流到约 1 分钟一次，容忍度需大于该值
        workerIdleCloseMs: 180000,        // 工作页空闲自动关闭
        aiTimeoutMs: 900000,              // AI 作答最长等待时间（15 分钟，防止深度思考过慢被误判失败）
        doneIdleMs: 6000,                 // 回答停止变化多久视为完成
        noJsonGraceMs: 300000,            // 回答中迟迟不出现 JSON 时的额外宽限时间
        aiMinWaitMs: 120000,              // 收到「完成」却解析不出答案时的最短等待（2 分钟，长任务需要更久）
    };

    // 两个站点的存储键互相独立，避免同时打开两个页面时互相抢占任务
    const SITES = {
        exam: {
            taskKey: 'ds_hw_task',
            relayKey: 'ds_hw_relay',
            heartbeatKey: 'ds_hw_heartbeat',
            relaySource: 'ds-homework-relay',
            closeKey: 'ds_hw_worker_close_req',
            ackKey: 'ds_hw_ack',
            claimedKey: 'ds_hw_claimed'
        },
        fz: {
            taskKey: 'ds_fz_task',
            relayKey: 'ds_fz_relay',
            heartbeatKey: 'ds_fz_heartbeat',
            relaySource: 'ds-fz-relay',
            closeKey: 'ds_fz_worker_close_req',
            ackKey: 'ds_fz_ack',
            claimedKey: 'ds_fz_claimed'
        },
    };

    const pageWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    const host = location.hostname;
    const isDeepSeek = host === 'chat.deepseek.com';
    const isExamPage = /(^|\.)onlineexamh5new\.zhihuishu\.com$/.test(host) && location.pathname.indexOf('stuExamWeb.html') !== -1;
    const isFzPage = /(^|\.)hiexam\.zhihuishu\.com$/.test(host) && location.pathname.indexOf('atHomeworkExam') !== -1;

    function log(msg, data) {
        console.log('[智慧树AI] ' + msg, data || '');
        try {
            Logger.add('info', msg);
        } catch (e) {
        }
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    /* ================== 答案 JSON 容错解析（面板与工作页共用） ================== */
    /**
     * 标准解析 + 常见错误修复（字符串内裸换行 / 尾逗号）。
     * 注意：模型写代码题时经常在字符串里输出未转义的双引号（如 "jdbc"），
     * 这类文本 JSON.parse 一定失败，需要退化到 scanLooseAnswers。
     */
    function parseJsonLoose(text) {
        const s = String(text == null ? '' : text).trim();
        if (!s) return null;
        try {
            const obj = JSON.parse(s);
            if (obj && typeof obj === 'object') return obj;
        } catch (e) {
        }
        try {
            const fixed = s
                .replace(/,\s*([}\]])/g, '$1')
                .replace(/"((?:[^"\\]|\\.)*)"/g, function (m, inner) {
                    return '"' + inner.replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t') + '"';
                });
            const obj = JSON.parse(fixed);
            if (obj && typeof obj === 'object') return obj;
        } catch (e) {
        }
        return null;
    }

    // 找到与 s[i]（起始括号）配对的结束位置，按 JSON 字符串转义规则跳过引号内容
    function matchBracket(s, i) {
        const open = s[i];
        const close = open === '[' ? ']' : '}';
        let depth = 0, inStr = false;
        for (let j = i; j < s.length; j++) {
            const ch = s[j];
            if (inStr) {
                if (ch === '\\') {
                    j++;
                    continue;
                }
                if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') {
                inStr = true;
                continue;
            }
            if (ch === open) depth++;
            else if (ch === close) {
                depth--;
                if (depth === 0) return j;
            }
        }
        return -1;
    }

    function skipWs(s, i) {
        while (i < s.length && /\s/.test(s[i])) i++;
        return i;
    }

    /**
     * 读取被引号包裹的字符串。
     * 结束判定不只看引号，还要看后面是否紧跟 } 或 ,"下一个题号":，
     * 这样字符串内容里未转义的引号（代码、SQL、JSON 片段）就不会被误判为结尾。
     */
    function readLooseQuoted(s, i, inArray) {
        i++;
        let out = '';
        while (i < s.length) {
            const ch = s[i];
            if (ch === '\\') {
                const nx = s[i + 1];
                if (nx === 'n') {
                    out += '\n';
                    i += 2;
                    continue;
                }
                if (nx === 't') {
                    out += '\t';
                    i += 2;
                    continue;
                }
                if (nx === 'r') {
                    i += 2;
                    continue;
                }
                if (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(s.substr(i + 2, 4))) {
                    out += String.fromCharCode(parseInt(s.substr(i + 2, 4), 16));
                    i += 6;
                    continue;
                }
                if (nx != null) {
                    out += nx;
                    i += 2;
                    continue;
                }
                i++;
                continue;
            }
            if (ch === '"' || ch === '”') {
                const j = skipWs(s, i + 1);
                const nx = s[j];
                let isEnd;
                if (inArray) {
                    isEnd = nx === undefined || nx === ',' || nx === ']' || nx === '}';
                } else {
                    isEnd = nx === undefined || nx === '}' ||
                        (nx === ',' && /^,\s*"(?:\d{1,4}(?:-\d{1,3})?)"\s*:/.test(s.slice(j, j + 32)));
                }
                if (isEnd) return {value: out, next: i + 1};
                out += ch;
                i++;
                continue;
            }
            out += ch;
            i++;
        }
        return {value: out, next: i};
    }

    function readLooseValue(s, i) {
        i = skipWs(s, i);
        if (i >= s.length) return null;
        const ch = s[i];
        if (ch === '[' || ch === '{') {
            const end = matchBracket(s, i);
            if (end > i) {
                try {
                    const parsed = JSON.parse(s.slice(i, end + 1));
                    if (Array.isArray(parsed)) return parsed.map(x => String(x).trim()).filter(Boolean);
                    if (parsed && typeof parsed === 'object') return parsed;
                } catch (e) {
                }
            }
            return ch === '[' ? readLooseArray(s, i) : null;
        }
        if (ch === '"' || ch === '“') return readLooseQuoted(s, i, false).value;
        let j = i;
        while (j < s.length && !/[,\}\]]/.test(s[j]) && s[j] !== '\n') j++;
        const bare = s.slice(i, j).trim();
        return bare || null;
    }

    function readLooseArray(s, i) {
        const arr = [];
        i++;
        while (i < s.length) {
            i = skipWs(s, i);
            const ch = s[i];
            if (ch == null || ch === ']') break;
            if (ch === ',') {
                i++;
                continue;
            }
            if (ch === '"' || ch === '“') {
                const r = readLooseQuoted(s, i, true);
                if (r.value) arr.push(r.value);
                i = r.next;
                continue;
            }
            let j = i;
            while (j < s.length && !/[,\]\}]/.test(s[j]) && s[j] !== '\n') j++;
            const bare = s.slice(i, j).trim();
            if (bare) arr.push(bare);
            if (j === i) break;
            i = j;
        }
        return arr;
    }

    // 从任意文本里扫描 "题号": 答案 对（最宽松的兜底）
    function scanLooseAnswers(text) {
        const s = String(text == null ? '' : text);
        if (!s) return null;
        const re = /"(?:\d{1,4}(?:-\d{1,3})?)"\s*:/g;
        const out = {};
        let n = 0, m;
        while ((m = re.exec(s))) {
            const key = m[0].replace(/^\s*"/, '').split('"')[0].trim();
            if (!key) continue;
            const v = readLooseValue(s, m.index + m[0].length);
            if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
            out[key] = v;
            n++;
        }
        return n ? out : null;
    }

    // 统一入口：先严格/半严格解析，再退化到扫描
    function pickAnswersObject(text) {
        const s = String(text == null ? '' : text).trim();
        if (!s) return null;
        const direct = parseJsonLoose(s);
        if (direct) return direct;
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) {
            const o = parseJsonLoose(fence[1].trim()) || scanLooseAnswers(fence[1]);
            if (o && Object.keys(o).length) return o;
        }
        const start = s.indexOf('{'), end = s.lastIndexOf('}');
        if (start !== -1 && end > start) {
            const o = parseJsonLoose(s.slice(start, end + 1)) || scanLooseAnswers(s.slice(start, end + 1));
            if (o && Object.keys(o).length) return o;
        }
        return scanLooseAnswers(s);
    }

    /* ================== 日志模块（两个站点共用：环形缓冲 + 级别过滤 + 面板渲染） ================== */
    const Logger = (function () {
        const MAX = 500;
        const LEVELS = {
            info: {label: '信息', group: 'info'},
            success: {label: '成功', group: 'info'},
            warn: {label: '警告', group: 'warn'},
            error: {label: '错误', group: 'error'}
        };
        const FILTERS = [
            {key: 'all', label: '全部'},
            {key: 'info', label: '信息'},
            {key: 'warn', label: '警告'},
            {key: 'error', label: '错误'}
        ];

        const items = [];
        const views = [];
        let seq = 0;
        let addListener = null;   // 精简模式用它把日志变成页面消息气泡

        function setAddListener(fn) {
            addListener = (typeof fn === 'function') ? fn : null;
        }

        function pad(n) {
            return n < 10 ? '0' + n : String(n);
        }

        function timeStr(d) {
            return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        }

        function norm(type) {
            return LEVELS[type] ? type : 'info';
        }

        function hit(item, filter) {
            return filter === 'all' || LEVELS[item.type].group === filter;
        }

        function countOf(group) {
            let n = 0;
            for (let i = 0; i < items.length; i++) if (LEVELS[items[i].type].group === group) n++;
            return n;
        }

        function rowEl(item, flash) {
            const row = document.createElement('div');
            row.className = 'zai-log-item zai-log-' + item.type + (flash ? ' zai-log-flash' : '');
            row.dataset.id = item.id;
            const t = document.createElement('span');
            t.className = 'zai-log-time';
            t.textContent = item.time;
            const lv = document.createElement('span');
            lv.className = 'zai-log-level';
            lv.textContent = LEVELS[item.type].label;
            const m = document.createElement('span');
            m.className = 'zai-log-msg';
            m.textContent = item.msg;
            row.appendChild(t);
            row.appendChild(lv);
            row.appendChild(m);
            return row;
        }

        function refreshChips(v) {
            v.chips.forEach(c => {
                const g = c.dataset.group;
                const cnt = c.querySelector('.zai-log-chip-count');
                if (cnt) cnt.textContent = String(g === 'all' ? items.length : countOf(g));
                c.classList.toggle('zai-log-chip-active', v.filter === g);
            });
            if (v.countEl) v.countEl.textContent = items.length + ' 条';
        }

        function scrollToEnd(v) {
            if (!v.auto) return;
            v.list.scrollTop = v.list.scrollHeight;
        }

        function setEmpty(v, text) {
            const old = v.list.querySelector('.zai-log-empty');
            if (old) old.remove();
            const e = document.createElement('div');
            e.className = 'zai-log-empty';
            e.textContent = text;
            v.list.appendChild(e);
        }

        function renderAll(v) {
            v.list.textContent = '';
            const frag = document.createDocumentFragment();
            let n = 0;
            for (let i = 0; i < items.length; i++) {
                if (hit(items[i], v.filter)) {
                    frag.appendChild(rowEl(items[i], false));
                    n++;
                }
            }
            v.list.appendChild(frag);
            if (!n) setEmpty(v, items.length ? '当前筛选无匹配日志' : '暂无日志');
            refreshChips(v);
            scrollToEnd(v);
        }

        function add(type, msg) {
            const t = norm(type);
            const item = {
                id: ++seq,
                type: t,
                msg: String(msg == null ? '' : msg),
                time: timeStr(new Date())
            };
            items.push(item);
            if (items.length > MAX) items.splice(0, items.length - MAX);

            views.forEach(v => {
                if (!v.list) return;
                if (!hit(item, v.filter)) {
                    refreshChips(v);
                    return;
                }
                const empty = v.list.querySelector('.zai-log-empty');
                if (empty) empty.remove();
                const row = rowEl(item, true);
                row.addEventListener('animationend', () => row.classList.remove('zai-log-flash'));
                v.list.appendChild(row);
                while (v.list.childNodes.length > MAX) v.list.removeChild(v.list.firstChild);
                refreshChips(v);
                scrollToEnd(v);
            });
            if (addListener) {
                try {
                    addListener(item);
                } catch (e) {
                }
            }
            return item;
        }

        function clear() {
            items.length = 0;
            views.forEach(renderAll);
        }

        function setFilter(v, key) {
            v.filter = key;
            renderAll(v);
        }

        function exportText(v) {
            const lines = [];
            for (let i = 0; i < items.length; i++) {
                if (hit(items[i], v.filter)) {
                    lines.push('[' + items[i].time + '] [' + LEVELS[items[i].type].label + '] ' + items[i].msg);
                }
            }
            return lines.join('\n');
        }

        function remove(root) {
            for (let i = views.length - 1; i >= 0; i--) {
                if (views[i].root === root) views.splice(i, 1);
            }
        }

        // 创建一个日志面板分区（可挂到任意面板底部；多个分区共享同一份日志数据）
        function createSection() {
            const root = document.createElement('div');
            root.className = 'zai-log';

            const head = document.createElement('div');
            head.className = 'zai-log-head';

            const title = document.createElement('span');
            title.className = 'zai-log-title';
            const titleText = document.createElement('span');
            titleText.textContent = '运行日志';
            const countEl = document.createElement('span');
            countEl.className = 'zai-log-count';
            countEl.textContent = '0 条';
            title.appendChild(titleText);
            title.appendChild(countEl);

            const spacer = document.createElement('span');
            spacer.className = 'zai-log-spacer';

            const copyBtn = document.createElement('button');
            copyBtn.className = 'zai-log-btn';
            copyBtn.type = 'button';
            copyBtn.textContent = '复制';
            copyBtn.title = '复制当前筛选的日志';

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'zai-log-btn';
            toggleBtn.type = 'button';
            toggleBtn.textContent = '收起';
            toggleBtn.title = '展开 / 收起日志列表';

            const clearBtn = document.createElement('button');
            clearBtn.className = 'zai-log-btn';
            clearBtn.type = 'button';
            clearBtn.textContent = '清空';
            clearBtn.title = '清空全部日志';

            head.appendChild(title);
            head.appendChild(spacer);
            head.appendChild(copyBtn);
            head.appendChild(toggleBtn);
            head.appendChild(clearBtn);

            const filters = document.createElement('div');
            filters.className = 'zai-log-filters';

            const chips = FILTERS.map(f => {
                const c = document.createElement('button');
                c.className = 'zai-log-chip' + (f.key === 'all' ? ' zai-log-chip-active' : '');
                c.type = 'button';
                c.dataset.group = f.key;
                const lb = document.createElement('span');
                lb.textContent = f.label;
                const cn = document.createElement('span');
                cn.className = 'zai-log-chip-count';
                cn.textContent = '0';
                c.appendChild(lb);
                c.appendChild(cn);
                c.addEventListener('click', () => setFilter(v, f.key));
                filters.appendChild(c);
                return c;
            });

            const autoLabel = document.createElement('label');
            autoLabel.className = 'zai-log-auto';
            const autoCb = document.createElement('input');
            autoCb.type = 'checkbox';
            autoCb.checked = true;
            autoCb.addEventListener('change', () => {
                v.auto = autoCb.checked;
                scrollToEnd(v);
            });
            autoLabel.appendChild(autoCb);
            autoLabel.appendChild(document.createTextNode('自动滚动'));
            filters.appendChild(autoLabel);

            const list = document.createElement('div');
            list.className = 'zai-log-list';

            root.appendChild(head);
            root.appendChild(filters);
            root.appendChild(list);

            const v = {
                root: root,
                list: list,
                chips: chips,
                countEl: countEl,
                filter: 'all',
                auto: true,
                collapsed: false
            };

            // 用户手动向上滚动时暂停自动跟随，回到底部自动恢复
            list.addEventListener('scroll', () => {
                const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
                if (atEnd !== v.auto) {
                    v.auto = atEnd;
                    autoCb.checked = atEnd;
                }
            });

            toggleBtn.addEventListener('click', () => {
                v.collapsed = !v.collapsed;
                list.style.display = v.collapsed ? 'none' : '';
                filters.style.display = v.collapsed ? 'none' : '';
                toggleBtn.textContent = v.collapsed ? '展开' : '收起';
                if (!v.collapsed) scrollToEnd(v);
            });

            clearBtn.addEventListener('click', () => clear());
            copyBtn.addEventListener('click', () => {
                const txt = exportText(v);
                if (!txt) return;
                const ta = document.createElement('textarea');
                ta.value = txt;
                ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
                document.body.appendChild(ta);
                ta.select();
                try {
                    document.execCommand('copy');
                } catch (e) {
                }
                ta.remove();
            });

            views.push(v);
            renderAll(v);
            return root;
        }

        return {
            add: add,
            clear: clear,
            remove: remove,
            createSection: createSection,
            setAddListener: setAddListener,
            info: function (m) {
                return add('info', m);
            },
            success: function (m) {
                return add('success', m);
            },
            warn: function (m) {
                return add('warn', m);
            },
            error: function (m) {
                return add('error', m);
            },
            items: items
        };
    })();

    if (!isDeepSeek) {

        /* ---------- A1. 内置提示词（两个站点共用） ---------- */
        /* ================== 2. 内置提示词（来自 1.js） ================== */
        const AI_PROMPT = `你是一名极其严谨、追求零失误的答题专家。请对下面每道题进行深入思考、反复推敲，再给出最终答案。

【答题流程（务必在内部完整执行）】
第一步 逐题精读：完整阅读题干，标出关键词、限定词（"都""仅""最""根本""前提""不包括"等）、否定词，以及题型（单选/多选/判断/填空等），避免因粗心误判。
第二步 逐项分析：对每一个选项单独判断真伪，说明它在什么条件下成立、在什么条件下不成立；尤其注意看似正确实则以偏概全、偷换概念、因果倒置的干扰项。
第三步 交叉验证：结合学科常识、教材原文、逻辑一致性三方面交叉验证；若多个选项都"像对的"，比较哪一个最贴合题干限定条件；若都对或都错，回到题干重新确认是否有遗漏条件。
第四步 自我复核：对已选出的答案反向质疑一次——"如果它是错的，最可能的反驳理由是什么？"如果反驳理由成立，则重新作答。
第五步 反复打磨：对不确定或存在争议的题，至少进行两轮独立推演，若两轮结论不一致，取证据更充分的一方，并再次核对选项文字与字母的对应关系。

【输出要求】
1. 只输出一个 JSON 对象，不要任何前言、解释、推理过程或 markdown 代码块标记
2. 格式为 {"题号": 答案}，键是题号字符串，值按题型决定：
   - 单选题 / 多选题 / 判断题：值为大写选项字母，多选连写（如 "AC"）
   - 填空题：只有一个空时写字符串；多个空时按空位顺序写成数组，例如 ["8080", "9000"]
   - 问答题 / 简答题 / 论述题等主观题：值为可直接提交的完整作答文本，换行与分点一律用转义换行符 \\n
3. 组合题的小题使用 "主题号-小题号" 作为键，例如 "3-1"
4. 每道题都必须作答，无法确定时也请给出最佳猜测，不要返回 null、空字符串或省略题号
5. 你的完整思考过程请保留在内部，回复中只允许出现最终 JSON

【选择题 / 判断题】
- 只给选项字母，不要附带选项文字，不要解释

【填空题：要求专业、精确、可直接判分】
- 只写应填入空位的内容本身：不重复题干、不加下划线/括号、"第1空"、"答："等任何标记，也不附加解释
- 用教材与行业标准的规范表述，不要同义改写、不要口语化；专有名词按标准写法保留大小写（如 Spark SQL、DataFrame、Catalyst、RDD、DAG、JVM、MySQL）
- 数值必须精确并带单位；端口、版本、进制、阈值、复杂度等按原题语境给出确定值
- 涉及代码或表达式时，给出完整可读的代码或表达式，保留原始缩进、引号与大小写
- 一个空只填一个答案（词、短语或数值），不要用整句作答；多个空严格按空位顺序一一对应，数量必须与空数相同
- 某个空确实拿不准时，给出该领域最通用的标准答案，不要留空、不要写"不确定/可能是"

【问答题 / 简答题 / 论述题：要求专业、具体、结构化】
- 首句直接给核心结论（是什么 / 有什么作用 / 结论性判断），随后分点展开，每点写成"1. 要点名：机制或原因或示例"
- 必须写到课程与教材层面的术语、组件名、关键机制、执行步骤、参数、公式、复杂度、优缺点或适用场景；禁止"很重要""有很多好处""可以有效提升"这类空泛表述
- 要点数量与分值匹配：5 分以内写 3~4 点；6~10 分写 5~6 点；更高分值按"定义 → 原理 → 流程 → 对比/优缺点 → 示例"依次展开
- 篇幅：单个要点 30~60 字，整体 150~500 字（按题目要求与分值取舍）；不复述题干、不凑字数、不重复同一意思
- 按题型选结构：流程类用"步骤 1/2/3"；对比类用"维度：A …；B …"；原理类先讲机制再讲结果；代码类先给要点，再贴完整代码
- 英文术语可在中文后括号补一次原文（如"催化剂优化器（Catalyst）"），同一术语全篇只补一次
- 不使用"答：""综上""总之""以上就是"等套话，不加题号，不输出与题目无关的扩展
- 题目要求"简要"时压缩到 3 点以内；要求"详述/论述"时必须展开到机制与步骤层面

【重要提醒】
- 选项字母 A/B/C/D 严格按题目中出现的顺序标注，不要按内容自行重排
- 判断题的选项顺序是随机打乱的，可能是"对/错"，也可能是"错/对"
- 请先依据选项文字内容判断正确答案，再选择对应的字母，不要默认 A 就是"对"
- 填空题请先数清题干里有几个空（____ 或（ ）的个数），答案段数必须与空数相同
- 主观题（填空 / 问答）绝不能返回空字符串，哪怕不确定也要给出专业答案
- 若发现某题题干或选项表述存在歧义，选择在学术与教材语境下最通用、最稳妥的答案

【示例】
题目：
1. [判断题] 地球是圆的。（ ）
   A. 错
   B. 对
2. [多选题] 下列属于传输层协议的有（ ）。
   A. TCP
   B. UDP
   C. IP
   D. HTTP
3. [填空题] Spark 默认的 Web UI 端口是 ____，HDFS 默认的 NameNode 端口是 ____。
4. [问答题] 简述 Spark SQL 中 Catalyst 优化器的工作流程。
正确输出：{"1":"B","2":"AB","3":["8080","9000"],"4":"Catalyst 是 Spark SQL 的查询优化框架，按“解析 → 分析 → 优化 → 物理计划 → 执行”五个阶段把逻辑计划转换为可执行计划。\\n1. 解析（Parse）：将 SQL 文本或 DataFrame 操作解析为未解析的逻辑计划（Unresolved Logical Plan）。\\n2. 分析（Analyze）：借助 Catalog 元数据完成表与字段绑定，得到已解析的逻辑计划（Analyzed Logical Plan）。\\n3. 优化（Optimize）：应用基于规则的优化（RBO，如谓词下推、列裁剪、常量折叠）与基于代价的优化（CBO）得到优化后的逻辑计划。\\n4. 物理计划（Physical Plan）：将逻辑计划转换为多个物理计划，由 CostModel 选出代价最小者。\\n5. 执行（Execute）：调用物理计划的 execute() 生成 RDD，交由 Tungsten 执行引擎运行并返回结果。"}`;


        /* ---------- A2. 答案文本解析（两个站点共用） ---------- */

        /* ================== 4. 答案文本解析（来自 1.js） ================== */
        /**
         * 单个答案值归一化：
         * - 纯字母（含 "A,B" / "A、B" / "A B" 等写法）→ 选项字母串 "AB"
         * - 数组 → 元素全是单字母时合并为字母串，否则保留字符串数组（填空多空）
         * - 其余文本（填空题 / 问答题）原样保留，只规整换行与首尾空白
         */
        function normalizeAnswerValue(v) {
            if (v == null) return '';
            if (Array.isArray(v)) {
                const arr = [];
                v.forEach(function (x) {
                    const one = normalizeAnswerValue(x);
                    if (Array.isArray(one)) one.forEach(function (y) {
                        if (y) arr.push(y);
                    });
                    else if (one) arr.push(one);
                });
                if (!arr.length) return '';
                if (arr.every(function (x) {
                    return /^[A-Ha-h]$/.test(x);
                })) return arr.join('').toUpperCase();
                return arr;
            }
            if (typeof v === 'object') {
                const keys = ['answer', 'answers', 'value', 'content', 'text', '答案'];
                for (let i = 0; i < keys.length; i++) {
                    if (v[keys[i]] != null) return normalizeAnswerValue(v[keys[i]]);
                }
                return '';
            }
            const s = String(v).replace(/\r\n?/g, '\n').trim();
            if (!s) return '';
            const letters = lettersOnly(s);
            if (letters) return letters;
            return s;
        }

        // 判断字符串是否只是选项字母（A-H，允许 "A,B" / "A、B" / "A B" 等分隔写法）
        // 纯字母单词（如填空答案 TCP / pH）不算选项字母，避免被误改大小写
        function lettersOnly(s) {
            const raw = String(s == null ? '' : s).trim();
            if (!raw) return '';
            if (!/^[A-Ha-h](?:[\s,，、;；]*[A-Ha-h])*$/.test(raw)) return '';
            return raw.toUpperCase().replace(/[^A-H]/g, '');
        }

        function normalizeAnswers(obj) {
            const out = {};
            for (const k of Object.keys(obj)) {
                const key = String(k).trim();
                if (!key) continue;
                const v = normalizeAnswerValue(obj[k]);
                if (Array.isArray(v) ? v.length : v) out[key] = v;
            }
            return out;
        }

        // 只取选项字母（填空 / 问答这类纯文本答案返回空串），供选择题逻辑使用
        function answerToLetters(v) {
            if (Array.isArray(v)) v = v.join('');
            return lettersOnly(v);
        }

        // 解析答案文本：严格 JSON → 半严格修复 → 逐题扫描兜底（parseJsonLoose / pickAnswersObject 在公共层）
        function extractAnswersFromText(text) {
            if (!text) return null;
            const obj = pickAnswersObject(text);
            if (!obj) return null;
            const n = normalizeAnswers(obj);
            return Object.keys(n).length ? n : null;
        }


        /* ---------- A3. UI 公共：样式 / 组件 / 剪贴板 / 拖拽（两个站点共用） ---------- */
        /* ================== 8. 样式（来自 1.js） ================== */
        const CSS = `
.zai-panel{position:fixed;top:56%;right:20px;transform:translateY(-50%);width:440px;max-width:calc(100vw - 40px);max-height:80vh;background:#faf5eb;color:#3d3226;border-radius:14px;box-shadow:0 12px 40px rgba(90,70,40,.22),0 2px 8px rgba(90,70,40,.10);z-index:2147483647;font-family:ui-monospace,'Cascadia Code',Consolas,Menlo,monospace;font-size:12px;line-height:1.65;display:flex;flex-direction:column;overflow:hidden;border:1px solid #e0d4bc;}
.zai-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:linear-gradient(135deg,#e8dcc4,#d9c9a8);cursor:move;user-select:none;flex-shrink:0;border-bottom:1px solid #d4c4a8;}
.zai-tabbar{display:flex;padding:8px 12px;background:#f0e8d8;flex-shrink:0;border-bottom:1px solid #e0d4bc;}
.zai-tab{flex:1;border:1px solid #d4c4a8;background:#f0e8d8;color:#8a7a62;font-family:inherit;font-size:11.5px;font-weight:600;padding:6px 10px;cursor:pointer;line-height:1.2;white-space:nowrap;transition:background .15s,color .15s;}
.zai-tab + .zai-tab{border-left:none;}
.zai-tab:first-child{border-radius:8px 0 0 8px;}
.zai-tab:last-child{border-radius:0 8px 8px 0;}
.zai-tab:hover:not(:disabled):not(.zai-tab-active){background:#e8dcc4;color:#6b4f2a;}
.zai-tab:disabled{opacity:.55;cursor:not-allowed;}
.zai-tab-active{background:linear-gradient(135deg,#d4a574,#c9a227);border-color:#b8860b;color:#fffdf7;box-shadow:inset 0 1px 3px rgba(90,70,40,.15);}
.zai-title{font-weight:700;color:#6b4f2a;font-size:13px;letter-spacing:.3px;}
.zai-hbtns{display:flex;gap:6px;}
.zai-icon-btn{width:26px;height:26px;border:none;border-radius:8px;background:rgba(255,253,247,.6);color:#6b4f2a;font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;line-height:1;padding:0;font-family:inherit;}
.zai-icon-btn:hover{background:#fffdf7;transform:scale(1.08);}
.zai-icon-btn:active{transform:scale(.94);}
.zai-toolbar{display:flex;gap:8px;align-items:center;padding:8px 12px;background:#f0e8d8;flex-shrink:0;border-bottom:1px solid #e0d4bc;}
.zai-btn{border:1px solid #d4c4a8;border-radius:8px;padding:5px 12px;font-size:11.5px;cursor:pointer;background:#fffdf7;color:#5a4a38;font-weight:600;transition:all .15s;font-family:inherit;}
.zai-btn:hover{background:#fffaf0;border-color:#b8860b;color:#8b6914;}
.zai-btn:active{transform:translateY(1px);}
.zai-btn:disabled{opacity:.55;cursor:not-allowed;transform:none!important;box-shadow:none!important;}
.zai-btn-primary{border:none;background:linear-gradient(135deg,#d4a574,#c9a227);color:#fffdf7;box-shadow:0 2px 6px rgba(180,130,60,.35);}
.zai-btn-primary:hover:not(:disabled){background:linear-gradient(135deg,#c99a6a,#b8921a);box-shadow:0 3px 10px rgba(180,130,60,.45);color:#fffdf7;}
.zai-btn-primary:active:not(:disabled){transform:translateY(1px);box-shadow:0 1px 3px rgba(180,130,60,.35);}
.zai-body{padding:12px;overflow-y:auto;flex:1;background:#faf5eb;scrollbar-width:thin;scrollbar-color:#d4c4a8 #f0e8d8;}
.zai-body::-webkit-scrollbar{width:8px;}
.zai-body::-webkit-scrollbar-track{background:#f0e8d8;border-radius:4px;}
.zai-body::-webkit-scrollbar-thumb{background:#d4c4a8;border-radius:4px;}
.zai-body::-webkit-scrollbar-thumb:hover{background:#b8a888;}
.zai-footer{padding:10px 12px;background:#f0e8d8;border-top:1px solid #e0d4bc;flex-shrink:0;display:flex;flex-direction:column;gap:8px;}
.zai-textarea{width:100%;box-sizing:border-box;min-height:60px;background:#fffdf7;color:#3d3226;border:1.5px solid #e0d4bc;border-radius:8px;padding:8px 10px;font:11.5px/1.5 ui-monospace,Consolas,Menlo,monospace;resize:vertical;outline:none;transition:border-color .15s,box-shadow .15s;}
.zai-textarea::placeholder{color:#a89880;}
.zai-textarea:focus{border-color:#c9a227;box-shadow:0 0 0 3px rgba(201,162,39,.12);}
.zai-action-row{display:flex;gap:10px;align-items:center;}
.zai-status{font-size:11px;color:#8a7a62;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.zai-status-info{color:#8b6914;}
.zai-status-success{color:#5a7a20;}
.zai-status-warn{color:#b8860b;}
.zai-status-error{color:#c0392b;}
.zai-summary{background:#fffdf7;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:11.5px;line-height:1.75;border-left:3px solid #b8860b;box-shadow:0 1px 3px rgba(90,70,40,.06);}
.zai-summary-title{color:#8b6914;font-weight:700;font-size:12.5px;margin-bottom:3px;}
.zai-summary-meta{color:#b8860b;}
.zai-url{color:#a89880;font-size:10px;margin-bottom:10px;word-break:break-all;}
.zai-card{background:#fffdf7;border-radius:10px;padding:10px 12px;margin-bottom:10px;border-left:3px solid #d4a574;box-shadow:0 1px 3px rgba(90,70,40,.06);transition:box-shadow .15s;}
.zai-card:hover{box-shadow:0 2px 8px rgba(90,70,40,.10);}
.zai-card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;}
.zai-card-num{color:#8b6914;font-weight:700;flex-shrink:0;}
.zai-card-tags{display:flex;gap:6px;align-items:center;flex-shrink:0;}
.zai-tag{background:#f0e8d8;color:#6b4f2a;border-radius:4px;padding:1px 7px;font-size:10px;font-weight:600;}
.zai-score{color:#6b8e23;font-size:11px;font-weight:600;}
.zai-stem{color:#3d3226;white-space:pre-wrap;word-break:break-word;margin-bottom:8px;}
.zai-options{display:flex;flex-direction:column;gap:4px;}
.zai-option{display:flex;gap:8px;font-size:11.5px;color:#5a4a38;line-height:1.55;padding:4px 8px;border-radius:6px;background:#faf6ee;}
.zai-option-label{color:#a67c52;font-weight:700;flex-shrink:0;}
.zai-option-content{word-break:break-word;}
.zai-sub{margin-top:8px;padding-left:10px;border-left:2px solid #e0d4bc;display:flex;flex-direction:column;gap:8px;}
.zai-report{background:#fffdf7;border-radius:10px;padding:10px 12px;margin-bottom:12px;border-left:3px solid #4D6BFE;box-shadow:0 1px 3px rgba(90,70,40,.06);font-size:11.5px;line-height:1.8;}
.zai-report-title{color:#8b6914;font-weight:700;font-size:12.5px;margin-bottom:6px;}
.zai-report-row{display:flex;gap:8px;align-items:baseline;}
.zai-report-num{color:#a67c52;font-weight:700;flex-shrink:0;min-width:46px;}
.zai-report-ok{color:#5a7a20;}
.zai-report-bad{color:#c0392b;}
.zai-report-warn{color:#b8860b;}
.zai-waiting{color:#8a7a62;}
.zai-error{color:#c0392b;}
.zai-btn:focus-visible,.zai-icon-btn:focus-visible,.zai-tab:focus-visible,.zai-textarea:focus-visible{outline:2px solid #b8860b;outline-offset:2px;}
@media (prefers-reduced-motion:reduce){.zai-panel *,.zai-panel{transition:none!important;animation:none!important;}}

/* ===================== 视觉统一：设计变量 / 排版 / 组件 ===================== */
.zai-panel{
    --zai-bg:#faf6ee; --zai-bg-alt:#f2ebdc; --zai-surface:#fffdf8;
    --zai-border:#e3d7bf; --zai-border-strong:#d2c1a0;
    --zai-text:#3f3428; --zai-text-dim:#8a7a62;
    --zai-brand:#c9a227; --zai-brand-soft:#d4a574;
    --zai-info:#8b6914; --zai-ok:#5a7a20; --zai-warn:#b8860b; --zai-err:#c0392b;
    --zai-radius:12px; --zai-gap:10px;
    --zai-shadow:0 14px 40px rgba(90,70,40,.20),0 2px 8px rgba(90,70,40,.10);
    font-family:'Segoe UI','PingFang SC','Microsoft YaHei',ui-monospace,'Cascadia Code',Consolas,Menlo,monospace;
    font-size:12px; line-height:1.6; color:var(--zai-text);
    border-radius:var(--zai-radius); box-shadow:var(--zai-shadow);
    border:1px solid rgba(180,150,100,.35); background:var(--zai-bg);
}
.zai-header{padding:11px 14px;background:linear-gradient(135deg,#f0e5d1 0%,#e0d0af 100%);border-bottom:1px solid var(--zai-border-strong);}
.zai-title{font-size:13px;letter-spacing:.4px;}
.zai-icon-btn{width:26px;height:26px;border-radius:8px;background:rgba(255,255,255,.55);border:1px solid rgba(150,120,80,.18);}
.zai-icon-btn:hover{background:#fff;border-color:var(--zai-brand);}
.zai-tabbar{padding:8px 12px;background:var(--zai-bg-alt);}
.zai-tabbar[role=tablist]{gap:6px;background:transparent;padding:7px 12px;}
.zai-tabbar[role=tablist] .zai-tab{border:1px solid var(--zai-border-strong);border-radius:8px;}
.zai-tabbar[role=tablist] .zai-tab + .zai-tab{border-left:1px solid var(--zai-border-strong);}
.zai-tabbar[role=tablist] .zai-tab:first-child,
.zai-tabbar[role=tablist] .zai-tab:last-child{border-radius:8px;}
.zai-toolbar{padding:9px 12px;gap:8px;flex-wrap:wrap;background:var(--zai-bg-alt);}
.zai-btn{padding:6px 12px;border-radius:9px;letter-spacing:.2px;box-shadow:0 1px 2px rgba(90,70,40,.06);}
.zai-btn:hover:not(:disabled){transform:translateY(-1px);}
.zai-btn-primary{box-shadow:0 2px 8px rgba(180,130,60,.32);}
.zai-body{padding:12px;background:var(--zai-bg);}
.zai-footer{padding:10px 12px;gap:8px;background:var(--zai-bg-alt);}
.zai-textarea{border-radius:9px;padding:9px 10px;line-height:1.6;}
.zai-card,.zai-summary,.zai-report{border-radius:var(--zai-radius);padding:11px 12px;}
.zai-option{padding:5px 8px;border-radius:7px;}

/* ===================== 日志面板 ===================== */
.zai-log{border-top:1px solid var(--zai-border);background:var(--zai-bg-alt);flex-shrink:0;display:flex;flex-direction:column;}
.zai-log-head{display:flex;align-items:center;gap:8px;padding:7px 12px 5px;}
.zai-log-title{display:flex;align-items:center;gap:6px;font-weight:700;font-size:11.5px;color:#6b4f2a;}
.zai-log-count{font-size:10px;font-weight:600;color:var(--zai-text-dim);}
.zai-log-spacer{flex:1;}
.zai-log-btn{border:1px solid var(--zai-border-strong);background:var(--zai-surface);color:#6b4f2a;border-radius:7px;padding:3px 9px;font-size:10.5px;font-weight:600;cursor:pointer;font-family:inherit;line-height:1.4;transition:background .15s,border-color .15s,color .15s;}
.zai-log-btn:hover{border-color:var(--zai-brand);color:#8b6914;background:#fff;}
.zai-log-btn:active{transform:translateY(1px);}
.zai-log-btn:focus-visible{outline:2px solid var(--zai-brand);outline-offset:2px;}
.zai-log-filters{display:flex;align-items:center;gap:6px;padding:0 12px 7px;flex-wrap:wrap;}
.zai-log-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--zai-border-strong);background:transparent;color:var(--zai-text-dim);border-radius:999px;padding:2px 10px;font-size:10.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s,border-color .15s,color .15s;}
.zai-log-chip:hover{border-color:var(--zai-brand);color:#8b6914;}
.zai-log-chip:focus-visible{outline:2px solid var(--zai-brand);outline-offset:2px;}
.zai-log-chip-active{background:linear-gradient(135deg,#d4a574,#c9a227);border-color:#b8860b;color:#fffdf7;}
.zai-log-chip-count{opacity:.75;font-weight:700;font-variant-numeric:tabular-nums;}
.zai-log-auto{display:inline-flex;align-items:center;gap:4px;margin-left:auto;font-size:10.5px;color:var(--zai-text-dim);cursor:pointer;user-select:none;}
.zai-log-auto input{margin:0;accent-color:#c9a227;cursor:pointer;}
.zai-log-list{max-height:148px;overflow-y:auto;padding:5px 10px 8px;background:var(--zai-surface);border-top:1px solid var(--zai-border);font-family:ui-monospace,Consolas,Menlo,monospace;scrollbar-width:thin;scrollbar-color:#d4c4a8 #f0e8d8;}
.zai-log-list::-webkit-scrollbar{width:8px;}
.zai-log-list::-webkit-scrollbar-track{background:#f0e8d8;border-radius:4px;}
.zai-log-list::-webkit-scrollbar-thumb{background:#d4c4a8;border-radius:4px;}
.zai-log-list::-webkit-scrollbar-thumb:hover{background:#b8a888;}
.zai-log-item{display:flex;gap:8px;align-items:flex-start;padding:4px 8px;border-radius:6px;border-left:3px solid transparent;font-size:11px;line-height:1.55;transition:background .15s;}
.zai-log-item:hover{background:#f4ecdc;}
.zai-log-time{flex-shrink:0;color:#a89880;font-variant-numeric:tabular-nums;}
.zai-log-level{flex-shrink:0;margin-top:1px;padding:0 5px;border-radius:4px;font-size:10px;font-weight:700;line-height:16px;}
.zai-log-msg{flex:1;color:#4a3f31;word-break:break-word;}
.zai-log-info{border-left-color:#d4a574;}
.zai-log-info .zai-log-level{background:rgba(139,105,20,.12);color:#8b6914;}
.zai-log-success{border-left-color:#7a9a3a;}
.zai-log-success .zai-log-level{background:rgba(90,122,32,.14);color:#5a7a20;}
.zai-log-warn{border-left-color:#d9a520;background:rgba(217,165,32,.06);}
.zai-log-warn .zai-log-level{background:rgba(184,134,11,.16);color:#b8860b;}
.zai-log-error{border-left-color:var(--zai-err);background:rgba(192,57,43,.07);}
.zai-log-error .zai-log-level{background:rgba(192,57,43,.15);color:var(--zai-err);}
.zai-log-error .zai-log-msg{color:#a32e22;}
.zai-log-empty{padding:10px 2px;text-align:center;font-size:11px;color:#a89880;}
.zai-log-flash{animation:zai-flash 1.4s ease-out;}
@keyframes zai-flash{
    0%{box-shadow:inset 0 0 0 9999px rgba(201,162,39,.30);}
    100%{box-shadow:inset 0 0 0 9999px rgba(201,162,39,0);}
}

/* ===================== 使用前须知 ===================== */
.zai-icon-btn--wide{width:auto;padding:0 10px;font-size:11.5px;font-weight:600;letter-spacing:.2px;}
.zai-notice-mask{position:fixed;inset:0;background:rgba(60,48,32,.45);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;}
.zai-notice{width:540px;max-width:100%;max-height:80vh;overflow:auto;background:#fffdf8;color:#3f3428;border-radius:14px;border:1px solid #d2c1a0;box-shadow:0 18px 50px rgba(60,48,32,.35);padding:18px 20px;font-family:'Segoe UI','PingFang SC','Microsoft YaHei',ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.8;}
.zai-notice-title{font-size:15px;font-weight:700;color:#6b4f2a;margin-bottom:10px;}
.zai-notice-list{margin:0;padding-left:18px;}
.zai-notice-list li{margin-bottom:7px;}
.zai-notice-actions{display:flex;justify-content:flex-end;margin-top:14px;}

/* ===================== 精简模式 ===================== */
.zai-panel.zai-compact{width:344px;border-radius:16px;box-shadow:0 18px 44px rgba(90,70,40,.22),0 2px 8px rgba(90,70,40,.10);}
.zai-compact .zai-tabbar,
.zai-compact .zai-footer,
.zai-compact .zai-body,
.zai-compact .zai-log{display:none;}
.zai-compact .zai-header{gap:8px;padding:11px 13px;background:linear-gradient(135deg,#f3e8d5,#e2d2b1);cursor:move;}
.zai-compact .zai-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;letter-spacing:.2px;}
.zai-compact .zai-hbtns{flex-shrink:0;gap:5px;}
.zai-compact .zai-hbtns .zai-icon-btn{height:24px;padding:0 9px;font-size:11px;border-radius:8px;background:rgba(255,255,255,.55);}
.zai-compact .zai-toolbar{padding:10px 12px;background:var(--zai-bg-alt);border-bottom:none;}
.zai-compact .zai-btn:not(.zai-btn-main){display:none;}
.zai-compact .zai-btn-main{width:100%;justify-content:center;border-radius:11px;font-size:13px;font-weight:700;letter-spacing:.6px;padding:10px 12px;box-shadow:0 4px 14px rgba(180,140,40,.30);transition:transform .16s cubic-bezier(.22,1,.36,1),box-shadow .2s ease,background .2s ease;}
.zai-compact .zai-btn-main:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 7px 18px rgba(180,140,40,.38);}
.zai-compact .zai-btn-main:active:not(:disabled){transform:translateY(1px);box-shadow:0 2px 6px rgba(180,140,40,.28);}
.zai-compact .zai-btn-main:disabled{background:linear-gradient(135deg,#ddcaa7,#ccba8e);box-shadow:none;}

/* 完成进度（精简面板内唯一的内容区） */
.zai-cprogress{display:none;flex-direction:column;gap:7px;padding:13px 14px 15px;border-top:1px solid var(--zai-border);background:linear-gradient(180deg,#fffdf8,#f6efe0);}
.zai-compact .zai-cprogress{display:flex;animation:zai-cp-enter .3s cubic-bezier(.22,1,.36,1);}
@keyframes zai-cp-enter{from{opacity:0;transform:translateY(-5px);}to{opacity:1;transform:none;}}

.zai-cp-top{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.zai-cp-chip{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 9px;border-radius:999px;font-size:10.5px;font-weight:700;letter-spacing:.3px;color:#8a6a1e;background:rgba(201,162,39,.14);transition:color .25s ease,background .25s ease;}
.zai-cp-chip::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.6;transition:opacity .2s ease;}
.zai-cp-chip--run{color:#8b6914;background:rgba(201,162,39,.18);}
.zai-cp-chip--run::before{opacity:1;animation:zai-cp-pulse 1.15s ease-in-out infinite;}
.zai-cp-chip--ok{color:#4d6b17;background:rgba(122,154,58,.16);}
.zai-cp-chip--err{color:#b3352b;background:rgba(192,57,43,.13);}
@keyframes zai-cp-pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.35;transform:scale(.7);}}

.zai-cp-pct{display:inline-flex;align-items:baseline;gap:1px;font-size:16px;font-weight:700;line-height:1;color:#8b6914;font-variant-numeric:tabular-nums;transition:color .25s ease;}
.zai-cp-pct-num--dim{color:#b3a084;letter-spacing:1px;}
.zai-cp-pct-num--dim + .zai-cp-pct-unit{display:none;}
.zai-cp-pct-unit{font-size:10px;font-weight:600;opacity:.65;}

.zai-cprogress-track{position:relative;height:9px;border-radius:999px;background:#e9dfc8;box-shadow:inset 0 1px 2px rgba(90,70,40,.14);overflow:hidden;}
.zai-cprogress-fill{position:relative;height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,#d9a86d,#c9a227);transition:width .55s cubic-bezier(.22,1,.36,1),background .3s ease,box-shadow .3s ease;}
.zai-cprogress-fill::after{content:'';position:absolute;inset:0;border-radius:inherit;background:linear-gradient(100deg,transparent 22%,rgba(255,255,255,.55) 50%,transparent 78%);opacity:0;}
.zai-cprogress-fill--run::after{opacity:1;animation:zai-cp-sheen 1.6s linear infinite;}
@keyframes zai-cp-sheen{from{transform:translateX(-100%);}to{transform:translateX(100%);}}
.zai-cprogress-fill--ok{background:linear-gradient(90deg,#a9cf74,#5a7a20);box-shadow:0 0 0 1px rgba(90,122,32,.18);animation:zai-cp-done .55s ease-out;}
@keyframes zai-cp-done{0%{box-shadow:0 0 0 0 rgba(90,122,32,.40);}100%{box-shadow:0 0 0 7px rgba(90,122,32,0);}}
.zai-cprogress-fill--err{background:linear-gradient(90deg,#e09186,#c0392b);}
.zai-cprogress-fill--indet{width:42%!important;background:linear-gradient(90deg,#e8cf9d,#c9a227 50%,#e8cf9d);background-size:200% 100%;transition:none;animation:zai-indet 1.5s linear infinite;}
@keyframes zai-indet{0%{background-position:0% 0;}100%{background-position:-200% 0;}}

.zai-cp-label{font-size:11.5px;line-height:1.5;color:#4a3f31;min-height:17px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}
.zai-cp-info{color:#6b5638;}
.zai-cp-success{color:#4d6b17;font-weight:600;}
.zai-cp-warn{color:#8a6412;}
.zai-cp-error{color:#b3352b;font-weight:600;}
.zai-cp-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;line-height:1.4;color:#a89880;font-variant-numeric:tabular-nums;}
.zai-cp-count{color:#8a7a62;font-weight:600;}
.zai-cp-rest{color:#b3a084;}
.zai-cprogress.zai-cp-shake .zai-cprogress-track{animation:zai-cp-shake .42s cubic-bezier(.36,.07,.19,.97);}
@keyframes zai-cp-shake{10%,90%{transform:translateX(-1px);}20%,80%{transform:translateX(2px);}30%,50%,70%{transform:translateX(-3px);}40%,60%{transform:translateX(3px);}}

/* ===================== 页面消息气泡（精简模式的实时日志） ===================== */
.zai-toasts{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483646;display:flex;flex-direction:column;align-items:center;gap:8px;max-width:min(420px,calc(100vw - 36px));pointer-events:none;font-family:'Segoe UI','PingFang SC','Microsoft YaHei',ui-monospace,Consolas,monospace;}
.zai-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:9px;padding:10px 12px;border-radius:12px;background:#fffdf8;border:1px solid #e3d7bf;box-shadow:0 10px 26px rgba(60,48,32,.16);font-size:12px;line-height:1.55;color:#3f3428;cursor:pointer;animation:zai-toast-in .22s ease-out;transition:box-shadow .15s,transform .15s;}
.zai-toast:hover{box-shadow:0 12px 30px rgba(60,48,32,.24);transform:translateY(-1px);}
.zai-toast-icon{flex:0 0 18px;width:18px;height:18px;margin-top:1px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;background:#c9a227;}
.zai-toast-msg{flex:1;min-width:0;word-break:break-word;}
.zai-toast-success .zai-toast-icon{background:#6f9a2e;}
.zai-toast-success{border-color:#d7e4bc;background:#fbfdf6;}
.zai-toast-warn .zai-toast-icon{background:#d0a02a;}
.zai-toast-warn{border-color:#ecd9a8;background:#fefbf0;}
.zai-toast-error .zai-toast-icon{background:#c0392b;}
.zai-toast-error{border-color:#f0ccc6;background:#fef6f4;}
.zai-toast-out{animation:zai-toast-out .2s ease-in forwards;}
@keyframes zai-toast-in{from{opacity:0;transform:translateY(-8px) scale(.98);}to{opacity:1;transform:none;}}
@keyframes zai-toast-out{to{opacity:0;transform:translateY(-6px) scale(.98);}}
@media (prefers-reduced-motion:reduce){
    .zai-toast,.zai-toast-out,.zai-cprogress-fill--indet,.zai-cprogress-fill--run::after,
    .zai-cprogress-fill--ok,.zai-compact .zai-cprogress,.zai-cp-chip--run::before,
    .zai-cprogress.zai-cp-shake .zai-cprogress-track{animation:none!important;transition:none!important;}
    .zai-toast:hover,.zai-compact .zai-btn-main:hover:not(:disabled){transform:none;}
}

/* ===================== 响应式 ===================== */
@media (max-width:560px){
    .zai-panel{left:10px;right:10px;top:50%;bottom:auto;transform:translateY(-50%);width:auto;max-width:none;max-height:72vh;}
    .zai-panel.zai-compact{width:auto;max-height:76vh;}
    .zai-toolbar{gap:6px;}
    .zai-btn{flex:1 1 auto;padding:6px 8px;}
    .zai-action-row{flex-wrap:wrap;gap:6px;}
    .zai-log-list{max-height:116px;}
    .zai-toasts{left:12px;right:12px;top:12px;max-width:none;transform:none;}
    .zai-toast{font-size:11.5px;padding:9px 11px;}
    .zai-notice{padding:14px 16px;font-size:12px;}
}
`;

        function injectStyle() {
            if (document.getElementById('zai-style')) return;
            const s = document.createElement('style');
            s.id = 'zai-style';
            s.textContent = CSS;
            (document.head || document.documentElement).appendChild(s);
        }

        function h(tag, cls, text) {
            const e = document.createElement(tag);
            if (cls) e.className = cls;
            if (text != null) e.textContent = text;
            return e;
        }

        // 面板 / 气泡只保留文字，去掉文案里的 emoji 图标
        const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu;

        function stripEmoji(text) {
            return String(text == null ? '' : text)
                .replace(EMOJI_RE, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim();
        }

        function prefersReducedMotion() {
            try {
                return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            } catch (e) {
                return false;
            }
        }

        function copyText(text) {
            const fallback = () => {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
                document.body.appendChild(ta);
                ta.select();
                try {
                    document.execCommand('copy');
                } catch (e) {
                }
                ta.remove();
            };
            try {
                const np = pageWindow.navigator.clipboard;
                if (np && np.writeText) np.writeText(text).catch(fallback);
                else fallback();
            } catch (e) {
                fallback();
            }
        }

        function makeDraggable(node, handle) {
            let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
            handle.addEventListener('mousedown', e => {
                if (e.target.tagName === 'BUTTON') return;
                dragging = true;
                sx = e.clientX;
                sy = e.clientY;
                const r = node.getBoundingClientRect();
                ox = r.left;
                oy = r.top;
                node.style.transform = 'none';
                node.style.left = ox + 'px';
                node.style.top = oy + 'px';
                node.style.right = 'auto';
                node.style.bottom = 'auto';
                e.preventDefault();
            });
            document.addEventListener('mousemove', e => {
                if (!dragging) return;
                node.style.left = (ox + e.clientX - sx) + 'px';
                node.style.top = (oy + e.clientY - sy) + 'px';
            });
            document.addEventListener('mouseup', () => {
                dragging = false;
            });
        }

        /* ---------- A3.5 使用前须知（两个站点共用） ---------- */
        function openNotice() {
            if (document.getElementById('zai-notice-mask')) return;
            injectStyle();

            const mask = h('div', 'zai-notice-mask');
            mask.id = 'zai-notice-mask';

            const box = h('div', 'zai-notice');
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');
            box.setAttribute('aria-label', '使用前须知');

            box.appendChild(h('div', 'zai-notice-title', '使用前须知'));

            const list = document.createElement('ol');
            list.className = 'zai-notice-list';
            [
                '首次使用会在后台自动打开 chat.deepseek.com 工作页，使用之前请在该页完成登录；不要手动关闭它，关闭后脚本会自动重开并重新提问。',
                '面板会自动抓取题目、获取答案、点选并保存，但不会点击「提交作业」，请核对后再自行提交。',
                '答案由 AI 生成，可能存在错误；填空题与问答题建议人工复核。',
                '提交之前一定要确认是否答完所有题目，脚本可能会抓漏或者ai会给漏，如遇到刷新重新答一次即可。'
            ].forEach(function (t) {
                const li = document.createElement('li');
                li.textContent = t;
                list.appendChild(li);
            });
            box.appendChild(list);

            const actions = h('div', 'zai-notice-actions');
            const okBtn = h('button', 'zai-btn zai-btn-primary', '我知道了');
            okBtn.type = 'button';
            actions.appendChild(okBtn);
            box.appendChild(actions);
            mask.appendChild(box);
            (document.body || document.documentElement).appendChild(mask);

            function close() {
                mask.remove();
                document.removeEventListener('keydown', onKey, true);
            }

            function onKey(e) {
                if (e.key === 'Escape' || e.key === 'Esc') close();
            }

            okBtn.addEventListener('click', close);
            mask.addEventListener('click', function (e) {
                if (e.target === mask) close();
            });
            document.addEventListener('keydown', onKey, true);
        }

        /* ---------- A3.6 页面级消息气泡（精简模式下代替面板日志） ---------- */
        const TOAST_MAX = 3;
        let toastWrap = null;
        let lastToastText = '';
        let lastToastAt = 0;
        let lastTickerToastAt = 0;

        function notify(type, msg) {
            const text = stripEmoji(msg);
            if (!text) return;
            const now = Date.now();
            // 进度类消息每秒都在变，限流到 5s 一条，避免刷屏
            if (/已等待|已收到|思考中/.test(text)) {
                if (now - lastTickerToastAt < 5000) return;
                lastTickerToastAt = now;
            } else if (text === lastToastText && now - lastToastAt < 1500) {
                return;
            }
            lastToastText = text;
            lastToastAt = now;

            injectStyle();
            if (!toastWrap || !toastWrap.isConnected) {
                toastWrap = h('div', 'zai-toasts');
                toastWrap.setAttribute('role', 'status');
                toastWrap.setAttribute('aria-live', 'polite');
                (document.body || document.documentElement).appendChild(toastWrap);
            }

            const lv = type === 'success' || type === 'warn' || type === 'error' ? type : 'info';
            const card = h('div', 'zai-toast zai-toast-' + lv);
            card.appendChild(h('span', 'zai-toast-icon', lv === 'success' ? '✓' : lv === 'error' ? '!' : lv === 'warn' ? '!' : 'i'));
            card.appendChild(h('span', 'zai-toast-msg', text));
            toastWrap.appendChild(card);
            while (toastWrap.childNodes.length > TOAST_MAX) toastWrap.removeChild(toastWrap.firstChild);

            let gone = false;

            function dismiss() {
                if (gone) return;
                gone = true;
                card.classList.add('zai-toast-out');
                setTimeout(function () {
                    card.remove();
                }, 220);
            }

            card.addEventListener('click', dismiss);
            setTimeout(dismiss, lv === 'error' ? 6500 : 3800);
        }

        /* ---------- A4. DeepSeek 中继客户端工厂（两个站点各建一个，存储键互相独立） ---------- */
        function createDeepSeekClient(siteKey) {
            const cfg = SITES[siteKey];
            let workerTab = null;
            let relayWaiter = null;
            let relayPollTimer = null;
            let relayInited = false;

            function isWorkerAlive() {
                try {
                    const hb = GM_getValue(cfg.heartbeatKey, 0);
                    return hb && (Date.now() - hb < CONFIG.heartbeatStale);
                } catch (e) {
                    return false;
                }
            }

            function isLocalWorkerOpen() {
                if (!workerTab) return false;
                try {
                    if (typeof workerTab.closed === 'boolean') return !workerTab.closed;
                    return true;
                } catch (e) {
                    return false;
                }
            }

            function ensureWorkerTab() {
                if (isLocalWorkerOpen()) {
                    log('复用本页打开的工作标签页');
                    return true;
                }
                if (isWorkerAlive()) {
                    log('检测到其他页面的工作标签页存活，直接复用');
                    return true;
                }
                return openWorkerTab();
            }

            function openWorkerTab() {
                // 方案1：GM_openInTab 后台打开，原页面焦点不变
                if (typeof GM_openInTab === 'function') {
                    try {
                        workerTab = GM_openInTab(CONFIG.deepseekUrl, {active: false, insert: true});
                        if (workerTab && typeof workerTab === 'object') {
                            try {
                                workerTab.onclose = function () {
                                    log('工作标签页已关闭');
                                    workerTab = null;
                                };
                            } catch (e) {
                            }
                        }
                        log('通过 GM_openInTab 后台打开 DeepSeek 工作页');
                        return true;
                    } catch (e) {
                        log('GM_openInTab 失败，降级 window.open', e);
                        workerTab = null;
                    }
                }
                // 方案2：降级 window.open + focus 拉回
                log('降级：window.open 打开工作页');
                let w = null;
                try {
                    w = pageWindow.open(CONFIG.deepseekUrl, CONFIG.workerName);
                } catch (e) {
                    log('window.open 异常', e);
                }
                if (!w || w.closed) {
                    log('弹窗被浏览器拦截');
                    workerTab = null;
                    return false;
                }
                workerTab = w;
                const pullFocus = function () {
                    try {
                        pageWindow.focus();
                    } catch (e) {
                    }
                };
                pullFocus();
                setTimeout(pullFocus, 0);
                setTimeout(pullFocus, 50);
                setTimeout(pullFocus, 200);
                return true;
            }

            /**
             * 尝试把被冻结的后台工作页激活。冻结状态下工作页的所有 JS 都会停摆，
             * 只有“激活标签页”能恢复；不同脚本管理器对句柄支持不同，全部做特性检测。
             */
            function wakeWorkerTab() {
                if (!workerTab) return false;
                try {
                    if (workerTab.closed) {   // 用户已经手动关掉了
                        workerTab = null;
                        return false;
                    }
                } catch (e) {
                }
                try {
                    if (typeof workerTab.focus === 'function') {
                        workerTab.focus();
                        return true;
                    }
                } catch (e) {
                }
                return false;
            }

            /**
             * 探测是否已有后台工作页在运行：任务写入后等待工作页回执（ackKey），
             * 有回执说明标签页已存在，直接复用，不再新开。
             * 心跳在后台标签页会被浏览器节流（最长约 1 分钟一次），不能作为唯一判据。
             */
            function waitWorkerAck(seq, timeoutMs) {
                return new Promise(function (resolve) {
                    if (typeof GM_getValue !== 'function') {
                        resolve(false);
                        return;
                    }
                    const limit = timeoutMs || 2500;
                    const startedAt = Date.now();
                    let done = false;
                    const finish = function (v) {
                        if (done) return;
                        done = true;
                        resolve(v);
                    };
                    const tick = function () {
                        if (done) return;
                        try {
                            const raw = GM_getValue(cfg.ackKey, null);
                            const ack = raw ? JSON.parse(raw) : null;
                            if (ack && ack.seq === seq) {
                                finish(true);
                                return;
                            }
                        } catch (e) {
                        }
                        if (Date.now() - startedAt >= limit) {
                            finish(false);
                            return;
                        }
                        setTimeout(tick, 150);
                    };
                    tick();
                });
            }

            /**
             * 探测可复用的工作页。心跳只是“最近有人写过库”的痕迹：
             * 用户手动关掉标签页后，心跳最多还会“存活”一个 stale 周期（90s），
             * 因此不能只看心跳就复用，必须以「工作页是否回执接管任务」为准。
             */
            function ensureWorkerReady(seq, force) {
                const suspect = !force && (isLocalWorkerOpen() || isWorkerAlive());
                // 有迹象时多等一会儿回执；毫无迹象（心跳为 0 / 句柄已关闭）就快速放行去开新页
                const waitMs = suspect ? 2500 : 800;
                log(suspect ? '检测到工作页痕迹，等待接管回执…' : '未检测到工作页，准备打开新标签页…');
                return waitWorkerAck(seq, waitMs).then(function (alive) {
                    if (alive) {
                        log('工作页已接管任务，复用现有标签页');
                        return true;
                    }
                    if (suspect) log('心跳存在但未收到接管回执（标签页可能已关闭或被冻结），改为新开工作页');
                    return openWorkerTab();
                });
            }

            function dispatchRelay(d) {
                if (!relayWaiter) return;
                if (d.taskSeq && d.taskSeq !== relayWaiter.seq) return;
                if (d.ts) {
                    if (d.ts <= relayWaiter.lastTs) return;
                    relayWaiter.lastTs = d.ts;
                }
                try {
                    relayWaiter.onRelay(d);
                } catch (e) {
                    log('回传处理异常', e);
                }
            }

            function initRelayChannels() {
                if (relayInited) return;
                relayInited = true;
                // 通道1：GM 存储变更监听（跨标签页，主力）
                if (typeof GM_addValueChangeListener === 'function') {
                    try {
                        GM_addValueChangeListener(cfg.relayKey, function (name, oldValue, newValue) {
                            let d = null;
                            try {
                                d = JSON.parse(newValue);
                            } catch (e) {
                            }
                            if (d) dispatchRelay(d);
                        });
                    } catch (e) {
                        log('注册回传监听失败', e);
                    }
                }
                // 通道2：window.opener postMessage
                pageWindow.addEventListener('message', function (e) {
                    if (!e.origin || e.origin.indexOf('https://chat.deepseek.com') !== 0) return;
                    const d = e.data;
                    if (!d || d.source !== cfg.relaySource) return;
                    dispatchRelay(d);
                });
            }

            function startRelayPolling() {
                if (relayPollTimer || typeof GM_getValue !== 'function') return;
                relayPollTimer = setInterval(function () {
                    if (!relayWaiter) {
                        stopRelayPolling();
                        return;
                    }
                    try {
                        const raw = GM_getValue(cfg.relayKey, null);
                        if (!raw) return;
                        const d = JSON.parse(raw);
                        if (d && d.source === cfg.relaySource) dispatchRelay(d);
                    } catch (e) {
                    }
                }, 80);
            }

            function stopRelayPolling() {
                if (relayPollTimer) {
                    clearInterval(relayPollTimer);
                    relayPollTimer = null;
                }
            }

            /**
             * 把文本提交给后台 DeepSeek 工作页，等待其回答完毕。
             * resolve({ answers, raw }) 或 resolve({ error })
             */
            function askDeepSeek(text, opts) {
                opts = opts || {};
                const timeoutMs = opts.timeoutMs || CONFIG.aiTimeoutMs;
                const onProgress = opts.onProgress || function () {
                };
                // 已知题目总数时，面板侧的兜底判定要求答案数不少于它，避免把流式输出到一半的 JSON 当完整答案
                const expectedCount = Number(opts.expectedCount) || 0;

                return new Promise(function (resolve) {
                    let settled = false;
                    const seq = Date.now();
                    const startedAt = Date.now();
                    let lastText = '';
                    const minWaitMs = (opts.minWaitMs != null) ? opts.minWaitMs : CONFIG.aiMinWaitMs;
                    let earlyDoneTimer = null;
                    let relaySettleTimer = null;
                    let relayTextAt = 0;
                    let lastHeartbeat = 0;
                    let lastHeartbeatAt = 0;
                    let wakeTried = 0;
                    let stallAt = 0;
                    let redispatched = false;
                    let activeSeq = seq;   // 自动重开工作页时会换成新的任务序号

                    function finish(res) {
                        if (settled) return;
                        settled = true;
                        if (earlyDoneTimer) {
                            clearTimeout(earlyDoneTimer);
                            earlyDoneTimer = null;
                        }
                        if (relaySettleTimer) {
                            clearTimeout(relaySettleTimer);
                            relaySettleTimer = null;
                        }
                        clearTimeout(timer);
                        clearInterval(ticker);
                        relayWaiter = null;
                        stopRelayPolling();
                        resolve(res);
                    }

                    // 解析已收到的文本；force=true 表示需要给出结论（此时仍要满足最短等待）
                    function settleFromText(force) {
                        const answers = extractAnswersFromText(lastText);
                        if (answers && Object.keys(answers).length) {
                            finish({answers: answers, raw: lastText});
                            return true;
                        }
                        if (!force) return false;
                        if (Date.now() - startedAt < minWaitMs) return false;
                        finish({error: '未能从 AI 回复中解析出答案 JSON，请手动复制粘贴'});
                        return true;
                    }

                    /**
                     * 面板侧兜底判定：工作页的 done 依赖它自己的定时器，后台标签页被节流时可能晚到
                     * 1 分钟以上甚至永远不到。面板本身在可见页，定时器不受影响，这里只要文本已经
                     * 完整（大括号闭合）且稳定 2.5s 就直接采信，不再等 done。
                     */
                    function settleFromRelay() {
                        relaySettleTimer = null;
                        if (settled || !lastText) return;
                        const idleMs = Date.now() - relayTextAt;
                        if (idleMs < 2500) {
                            // 定时器提前一点点触发的情况：补足剩余等待时间，避免这次判定被白白丢掉
                            relaySettleTimer = setTimeout(settleFromRelay, 2500 - idleMs + 20);
                            return;
                        }
                        const start = lastText.indexOf('{');
                        if (start === -1 || matchBracket(lastText, start) === -1) return;
                        const answers = extractAnswersFromText(lastText);
                        if (!answers) return;
                        if (expectedCount && Object.keys(answers).length < expectedCount) return;
                        finish({answers: answers, raw: lastText});
                    }

                    function scheduleRelaySettle() {
                        if (settled) return;
                        if (relaySettleTimer) clearTimeout(relaySettleTimer);
                        relaySettleTimer = setTimeout(settleFromRelay, 2500);
                    }

                    // 工作页彻底无响应时换一张新标签页重新提问：旧任务序号会被丢弃，
                    // 新标签页读到 taskKey 会重新作答，用户无需任何手动操作。
                    function redispatch() {
                        if (settled || !relayWaiter) return false;
                        const nextSeq = Date.now();
                        activeSeq = nextSeq;
                        relayWaiter.seq = nextSeq;
                        relayWaiter.lastTs = 0;
                        lastText = '';
                        lastRelayLen = 0;
                        relayTextAt = 0;
                        if (relaySettleTimer) {
                            clearTimeout(relaySettleTimer);
                            relaySettleTimer = null;
                        }
                        try {
                            GM_setValue(cfg.taskKey, JSON.stringify({
                                seq: nextSeq,
                                text: text,
                                targetLang: '中文',
                                mode: 'qa'
                            }));
                        } catch (e) {
                            return false;
                        }
                        log('工作页长时间无响应，已重新派发任务');
                        onProgress('♻️ 后台 DeepSeek 页无响应，已自动重开工作页重新提问…', 'warn');
                        ensureWorkerReady(nextSeq, true).then(function (ready) {
                            if (!ready && !settled) {
                                onProgress('⚠️ 自动重开工作页失败，请检查「打开标签页」权限', 'warn');
                            }
                        });
                        return true;
                    }

                    // 无响应时的自动恢复：先尝试激活，再不行就换新标签页重问
                    function handleStall(dead) {
                        if (settled) return;
                        const now = Date.now();
                        if (now - stallAt < 5000) return;   // 每 5s 最多处理一次，避免刷屏
                        stallAt = now;
                        // 明确已关闭（关闭页面时写了心跳 0）：激活无意义，直接重开
                        if (!dead && !redispatched && wakeTried < 1 && wakeWorkerTab()) {
                            wakeTried++;
                            log('工作页无响应，已尝试自动唤醒后台标签页');
                            onProgress('⚠️ 后台 DeepSeek 页无响应，正在自动唤醒…', 'warn');
                            return;
                        }
                        // 关掉的标签页无法激活，直接换一张新标签页重新提问
                        if (!redispatched && (dead || now - startedAt > 60000)) {
                            redispatched = true;
                            redispatch();
                            return;
                        }
                        onProgress('⚠️ 后台 DeepSeek 页无响应，等待其恢复…', 'warn');
                    }

                    function checkWorkerAlive() {
                        let hb = 0;
                        try {
                            hb = Number(GM_getValue(cfg.heartbeatKey, 0)) || 0;
                        } catch (e) {
                        }
                        if (hb && hb !== lastHeartbeat) {
                            lastHeartbeat = hb;
                            lastHeartbeatAt = Date.now();
                            return true;
                        }
                        // 心跳为 0：工作页关闭页面时会主动写 0；刚启动的新工作页也会短暂为 0，
                        // 所以给 15s 启动宽限，之后即可判定“标签页已不在”。
                        const closed = !hb && Date.now() - startedAt > 15000;
                        const silent = lastHeartbeatAt && Date.now() - lastHeartbeatAt > CONFIG.heartbeatStale;
                        if (!closed && !silent) {
                            if (!lastHeartbeatAt) lastHeartbeatAt = Date.now();
                            return true;
                        }
                        handleStall(!!closed);
                        return false;
                    }

                    const timer = setTimeout(function () {
                        finish({error: '等待超时：请确认后台 DeepSeek 标签页已登录且未关闭'});
                    }, timeoutMs);

                    let lastMsgAt = 0;
                    let lastRelayLen = 0;

                    const ticker = setInterval(function () {
                        // 后台工作页被冻结时心跳会停：这里自动唤醒，并把原因显示给用户
                        const alive = checkWorkerAlive();
                        // 只让「重要提示」短暂占位，流式回传不压制心跳，避免状态长时间静止
                        if (Date.now() - lastMsgAt < 2000) return;
                        const sec = Math.round((Date.now() - startedAt) / 1000);
                        const tail = lastRelayLen ? '，已收到 ' + lastRelayLen + ' 字' : '';
                        onProgress('AI 思考中… 已等待 ' + sec + 's' + tail + (alive ? '（后台 DeepSeek）' : '（后台 DeepSeek 无响应）'));
                    }, 1000);

                    relayWaiter = {
                        seq: activeSeq,
                        lastTs: 0,
                        onRelay: function (d) {
                            if (d.error) {
                                finish({error: 'AI 出错：' + d.error});
                                return;
                            }
                            if (typeof d.text === 'string' && d.text) {
                                const changed = d.text !== lastText;
                                lastText = d.text;
                                lastRelayLen = lastText.length;
                                if (changed) {
                                    relayTextAt = Date.now();
                                    scheduleRelaySettle();
                                }
                            }
                            if (!d.done) {
                                // 回答仍在增长：撤销之前的提前判定，继续等完整答案
                                if (earlyDoneTimer) {
                                    clearTimeout(earlyDoneTimer);
                                    earlyDoneTimer = null;
                                }
                                return;
                            }
                            if (settleFromText(false)) return;

                            const elapsed = Date.now() - startedAt;
                            if (elapsed >= minWaitMs) {
                                settleFromText(true);
                                return;
                            }

                            // 回传过早（深度思考 / 长任务常见）：先保留文本，至少等满 minWaitMs 再判定失败
                            if (earlyDoneTimer) return;
                            earlyDoneTimer = setTimeout(function () {
                                earlyDoneTimer = null;
                                settleFromText(true);
                            }, minWaitMs - elapsed);
                            lastMsgAt = Date.now();   // 这条提示较重要，短暂让心跳让位
                            onProgress('AI 已回传但暂未解析到答案，继续等待（最短 ' + Math.round(minWaitMs / 1000) + 's）…');
                        }
                    };

                    initRelayChannels();
                    startRelayPolling();
                    onProgress('正在提交任务给后台 DeepSeek…');

                    try {
                        GM_setValue(cfg.taskKey, JSON.stringify({
                            seq: seq,
                            text: text,
                            targetLang: '中文',
                            mode: 'qa'
                        }));
                    } catch (e) {
                        finish({error: '写入任务失败：' + e});
                        return;
                    }

                    ensureWorkerReady(seq).then(function (ready) {
                        if (!ready) {
                            finish({error: '无法打开 DeepSeek 后台工作页，请检查 Tampermonkey「打开标签页」权限'});
                        }
                    });
                });
            }

            return {
                isWorkerAlive: isWorkerAlive,
                isLocalWorkerOpen: isLocalWorkerOpen,
                ensureWorkerTab: ensureWorkerTab,
                ensureWorkerReady: ensureWorkerReady,
                openWorkerTab: openWorkerTab,
                initRelayChannels: initRelayChannels,
                askDeepSeek: askDeepSeek
            };
        }

        /* ---------- A5. 结果汇总：把未通过的题逐条打印到日志/控制台（两个站点共用） ---------- */
        function logFailedResults(results, progress) {
            const list = (results || []).filter(r => String(r.状态 || '').indexOf('✅') !== 0);
            if (!list.length) return list;
            progress(`⚠️ 共有 ${list.length} 题未通过校验：`, 'warn');
            list.forEach(r => {
                const actual = String(r.状态 || '').replace(/^❌\s*/, '');
                progress(`第 ${r.题号} 题：期望 ${r.期望}，实际 ${actual || '未作答'}`, 'error');
            });
            try {
                console.warn('[未通过校验的题目] ' + list.map(r => `第${r.题号}题 期望${r.期望} → ${r.状态}`).join('；'));
            } catch (e) {
            }
            return list;
        }

        /* ============================================================
         *  B. 共享课作业页（stuExamWeb，原 3.js 逻辑：抓包解析题目）
         * ============================================================ */
        if (isExamPage) {
            (function () {
                const ds = createDeepSeekClient('exam');

                const TARGET_HOST = 'studentexam-api.zhihuishu.com';
                const TARGET_PATH = '/studentExam/gateway/t/v1/student/doHomework';

                const pageWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

                /* ================== 1. 隐蔽化（来自 1.js） ================== */
                const disguised = new WeakSet();
                const nativeToString = pageWindow.Function.prototype.toString;
                pageWindow.Function.prototype.toString = new Proxy(nativeToString, {
                    apply(target, thisArg, args) {
                        if (disguised.has(thisArg)) {
                            return 'function ' + (thisArg.name || '') + '() { [native code] }';
                        }
                        return Reflect.apply(target, thisArg, args);
                    }
                });

                function disguise(fn) {
                    disguised.add(fn);
                    return fn;
                }

                /* ================== 3. 数据解析（来自 1.js） ================== */
                function stripHtml(html) {
                    if (html == null) return '';
                    const s = String(html);
                    if (!/[<&]/.test(s)) return s;
                    try {
                        const doc = new DOMParser().parseFromString(s, 'text/html');
                        doc.querySelectorAll('img').forEach(img => img.replaceWith(doc.createTextNode('［图片］')));
                        return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
                    } catch (e) {
                        return s.replace(/<[^>]*>/g, '');
                    }
                }

                function normalizeQuestion(q, idx) {
                    const typeName = (q && q.questionType && q.questionType.name) || '未知题型';
                    const options = ((q && q.questionOptions) || []).map((o, i) => ({
                        label: String.fromCharCode(65 + i),
                        content: stripHtml(o.content)
                    }));
                    const children = ((q && q.questionChildrens) || []).map((c, i) => normalizeQuestion(c, i + 1));
                    return {
                        index: idx,
                        stem: stripHtml(q && q.name),
                        typeName,
                        score: q && q.questionScore,
                        options,
                        children
                    };
                }

                function parseHomework(data) {
                    if (!data || !data.rt || !data.rt.examBase) return null;
                    const rt = data.rt, base = rt.examBase;
                    const questions = [];
                    (base.workExamParts || []).forEach(part => {
                        (part.questionDtos || []).forEach(q => questions.push(normalizeQuestion(q, questions.length + 1)));
                    });
                    return {
                        title: base.name || '',
                        course: base.courseName || '',
                        chapter: base.toChapter || '',
                        problemNum: base.problemNum,
                        totalScore: base.totalScore,
                        endTime: rt.examEndTime || '',
                        questions
                    };
                }

                /* ================== 6. 核对（保存后，来自 1.js） ================== */
                // 选项是否已选中：同时识别图标类名/图片与 input 真实状态。
                // input.checked 是同步更新的，可减轻页面状态回传延迟带来的误判。
                function isLabChecked(lab) {
                    if (lab.innerHTML.includes('onChecked')) return true;
                    const img = lab.querySelector('img');
                    if (img && img.src && img.src.includes('134c9fe')) return true;
                    const input = lab.querySelector('input[type="radio"], input[type="checkbox"]');
                    if (input && input.checked) return true;
                    return false;
                }

                function verifyAnswers(answers) {
                    const subjects = document.querySelectorAll('.examPaper_subject');
                    const results = [];
                    let successCount = 0;
                    subjects.forEach((subject, idx) => {
                        const numText = subject.querySelector('.subject_num span')?.innerText || String(idx + 1);
                        const num = numText.replace(/[^0-9]/g, '');
                        const expected = answers[num] || '无要求';
                        const nodeLabs = Array.from(subject.querySelectorAll('.nodeLab'));
                        const selectedIndexes = [];
                        nodeLabs.forEach((lab, i) => {
                            if (isLabChecked(lab)) selectedIndexes.push(i);
                        });
                        let status = '', detail = '';
                        if (!selectedIndexes.length) {
                            status = '❌ 未作答或未保存';
                        } else {
                            const actual = selectedIndexes.map(i => String.fromCharCode(65 + i)).join('');
                            const txt = selectedIndexes.map(i => nodeLabs[i].querySelector('.node_detail')?.innerText.trim() || '').filter(Boolean).join(' / ');
                            const same = actual.length === expected.length && actual.split('').every(ch => expected.includes(ch));
                            if (same) {
                                status = '✅ 正确';
                                successCount++;
                            } else {
                                status = `❌ 错误 (变成${actual}了)`;
                                detail = txt;
                            }
                        }
                        results.push({题号: num, 期望: expected, 状态: status, 选项内容: detail});
                    });
                    return {results, successCount, total: results.length};
                }

                /* ================== 6.5 带延迟补偿的核对 ================== */
                // 页面选中状态比真实传回慢 2-3 秒：连续多轮核对，
                // 结果仍在变化就等待刷新后复核；连续两轮一致或全部达标才采信，
                // 避免把"延迟"误报成"错误"而触发无谓的二次修正。
                async function verifyWithRetry(answers, onProgress, maxRounds) {
                    const wait = (ms) => new Promise(r => setTimeout(r, ms));
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    const rounds = maxRounds || 4;
                    let best = null;
                    let prevKey = '';
                    for (let i = 1; i <= rounds; i++) {
                        const v = verifyAnswers(answers);
                        if (!best || v.successCount > best.successCount) best = v;
                        const key = v.results.map(r => r.题号 + ':' + r.状态).join('|');
                        if (v.successCount === v.total) return v;   // 全部达标
                        if (key === prevKey) return best;           // 连续两轮一致，状态已稳定
                        prevKey = key;
                        if (i < rounds) {
                            progress(`⏳ 第 ${i} 轮核对：✅ ${v.successCount} / ${v.total}，等待页面状态刷新（约 2.5s）后复核…`, 'info');
                            await wait(2500);
                        }
                    }
                    return best;
                }

                /* ================== 7. 逐题作答并保存（来自 1.js，增加预检与重试） ================== */
                function getActionBtn(text) {
                    const btns = Array.from(document.querySelectorAll('.switch-btn-box button'));
                    return btns.find(b => (b.innerText || '').includes(text));
                }

                function isSubjectVisible(s) {
                    let p = s.parentElement;
                    while (p) {
                        if (p.style.display === 'none') return false;
                        p = p.parentElement;
                    }
                    return true;
                }

                function getVisibleSubject() {
                    const subjects = Array.from(document.querySelectorAll('.examPaper_subject'));
                    return subjects.find(isSubjectVisible) || null;
                }

                function getCurrentVisibleNum() {
                    const s = getVisibleSubject();
                    if (!s) return null;
                    const numText = s.querySelector('.subject_num span')?.innerText || '';
                    return numText.replace(/[^0-9]/g, '');
                }

                // 读取某题当前已选中的选项下标（判定逻辑与 verifyAnswers 保持一致）
                function readSelected(subject) {
                    const labs = Array.from(subject.querySelectorAll('.nodeLab'));
                    const indexes = [];
                    labs.forEach((lab, i) => {
                        if (isLabChecked(lab)) indexes.push(i);
                    });
                    return {labs, indexes};
                }

                function isSameSelection(actual, target) {
                    const t = String(target).toUpperCase().replace(/[^A-Z]/g, '');
                    const a = String(actual).toUpperCase().replace(/[^A-Z]/g, '');
                    return a.length > 0 && a.length === t.length && a.split('').every(ch => t.includes(ch));
                }

                /**
                 * 对单题执行作答（带预检，最多重试 maxAttempts 次）：
                 * - 当前已选 === 目标 → 跳过，避免二次点击把已选项清掉；
                 * - 不一致 → 先取消多选中多余的旧选项，再点选缺失的目标项，然后复检；
                 * - 复检不达标 → 重试，直至达标或达到次数上限。
                 */
                async function applyAnswerToSubject(subject, num, targetLetter, onProgress, maxAttempts) {
                    const wait = (ms) => new Promise(r => setTimeout(r, ms));
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    const attempts = maxAttempts || 3;
                    const targetLetters = String(targetLetter).toUpperCase().split('').filter(ch => /[A-Z]/.test(ch));
                    const targetIdx = targetLetters.map(l => l.charCodeAt(0) - 65);
                    let lastActual = '';

                    for (let attempt = 1; attempt <= attempts; attempt++) {
                        const sel = readSelected(subject);
                        lastActual = sel.indexes.map(i => String.fromCharCode(65 + i)).join('');

                        // 已符合目标：直接跳过，防止二次选择出错
                        if (isSameSelection(lastActual, targetLetter)) {
                            progress(`⏭️ 第 ${num} 题已是 ${lastActual}，符合 ${targetLetter}，跳过`, 'info');
                            return {ok: true, actual: lastActual, attempt};
                        }

                        // 取消多选中多余的旧选项（单选点目标会自动替换，无需处理）
                        sel.indexes.forEach(i => {
                            if (targetIdx.indexOf(i) !== -1) return;
                            const lab = sel.labs[i];
                            const cb = lab.querySelector('input[type="checkbox"]');
                            if (!cb) return;
                            lab.querySelector('.label')?.click();
                            cb.checked = false;
                            cb.dispatchEvent(new Event('change', {bubbles: true}));
                        });

                        // 点选尚未选中的目标项（已选中的不重复点击，避免被再次点击取消）
                        const cur = readSelected(subject).indexes;
                        targetIdx.forEach(ti => {
                            if (cur.indexOf(ti) !== -1) return;
                            const lab = sel.labs[ti];
                            if (!lab) return;
                            lab.querySelector('.label')?.click();
                            const input = lab.querySelector('input[type="radio"], input[type="checkbox"]');
                            if (input) {
                                input.checked = true;
                                input.dispatchEvent(new Event('change', {bubbles: true}));
                            }
                        });

                        await wait(600);

                        const sel2 = readSelected(subject);
                        lastActual = sel2.indexes.map(i => String.fromCharCode(65 + i)).join('');
                        if (isSameSelection(lastActual, targetLetter)) {
                            progress(`✅ 第 ${num} 题已选择 ${lastActual}`, 'info');
                            return {ok: true, actual: lastActual, attempt};
                        }
                        progress(`⚠️ 第 ${num} 题第 ${attempt}/${attempts} 次尝试后仍不达标（当前 ${lastActual || '空'}，期望 ${targetLetter}）`, 'warn');
                        await wait(800);
                    }
                    return {ok: false, actual: lastActual, attempt: attempts};
                }

                // 倒回第一题
                async function rewindToFirst(onProgress) {
                    const wait = (ms) => new Promise(r => setTimeout(r, ms));
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    progress('🔄 正在倒回第一题…', 'info');
                    // 优先：直接点击题号列表第一题
                    let firstLi = document.querySelector('.answerCard_list1 li');
                    if (!firstLi) {
                        await wait(500);
                        firstLi = document.querySelector('.answerCard_list1 li');
                    }
                    if (firstLi) {
                        firstLi.click();
                        await wait(600);
                        return;
                    }
                    // 兜底：连点「上一题」
                    let maxBack = 50;
                    let prevBtn = getActionBtn('上一题');
                    while (prevBtn && !prevBtn.disabled && maxBack > 0) {
                        prevBtn.click();
                        await wait(500);
                        prevBtn = getActionBtn('上一题');
                        maxBack--;
                    }
                }

                /**
                 * 单题「选完即校验」：选中后延迟复核当前题，不达标立刻修正，
                 * 确认与目标一致后才允许进入下一题。
                 */
                async function applyAndConfirmSubject(subject, num, targetLetter, onProgress) {
                    const wait = (ms) => new Promise(r => setTimeout(r, ms));
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    const rounds = 3;
                    let lastActual = '';

                    for (let round = 1; round <= rounds; round++) {
                        const sub = getVisibleSubject() || subject;
                        if (!sub) break;
                        const r = await applyAnswerToSubject(sub, num, targetLetter, onProgress, 2);
                        if (r.actual) lastActual = r.actual;

                        // 延迟复核：排除页面状态回写延迟造成的偏差
                        await wait(round === 1 ? 600 : 900);
                        const curNum = getCurrentVisibleNum();
                        if (curNum && curNum !== String(num)) {
                            progress(`↪️ 页面已自己切换到第 ${curNum} 题，第 ${num} 题视为完成`, 'info');
                            return {ok: true, actual: lastActual, advanced: true};
                        }
                        const curSub = getVisibleSubject() || sub;
                        const actual = readSelected(curSub).indexes.map(i => String.fromCharCode(65 + i)).join('');
                        if (actual) lastActual = actual;

                        if (isSameSelection(actual, targetLetter)) {
                            if (round > 1 || !r.ok) progress(`✅ 第 ${num} 题复核通过：${actual}`, 'success');
                            return {ok: true, actual, advanced: false};
                        }
                        progress(`⚠️ 第 ${num} 题第 ${round}/${rounds} 轮复核不达标（当前 ${actual || '空'}，期望 ${targetLetter}），自动修正…`, 'warn');
                    }
                    return {ok: false, actual: lastActual, advanced: false};
                }

                // 等待题号从 prevNum 变化，避免翻页未完成时重复处理同一题
                async function waitNumChange(prevNum, timeoutMs) {
                    const wait = (ms) => new Promise(r => setTimeout(r, ms));
                    const limit = timeoutMs || 2500;
                    const started = Date.now();
                    while (Date.now() - started < limit) {
                        await wait(150);
                        const n = getCurrentVisibleNum();
                        if (n && n !== prevNum) return n;
                    }
                    return getCurrentVisibleNum();
                }

                /**
                 * 从当前题开始逐题作答并保存：每题选完立即校验修正，通过后再进入下一题。
                 * 返回逐题结果用于完成后汇总（不再倒回第一题做全卷遍历检测）。
                 * onlyNums 为 null 时处理所有有答案的题；为数组时只处理指定题号。
                 */
                async function answerWalk(answers, onlyNums, onProgress) {
                    const wait = (ms) => new Promise(r => setTimeout(r, ms));
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    const results = [];

                    progress('🚀 开始逐题作答…', 'info');
                    let loopGuard = 300;
                    while (loopGuard-- > 0) {
                        const currentNum = getCurrentVisibleNum();
                        if (!currentNum) {
                            progress('⚠️ 未能识别当前题目，流程中断', 'warn');
                            break;
                        }

                        let advanced = false;
                        const targetLetter = answerToLetters(answers[currentNum]);
                        if (!targetLetter) {
                            if (!onlyNums) progress('⚠️ 第 ' + currentNum + ' 题无答案，跳过', 'warn');
                        } else if (!onlyNums || onlyNums.indexOf(currentNum) !== -1) {
                            progress('👉 第 ' + currentNum + ' 题：选择 ' + targetLetter, 'info');
                            const subject = getVisibleSubject();
                            if (subject) {
                                const r = await applyAndConfirmSubject(subject, currentNum, targetLetter, onProgress);
                                advanced = !!r.advanced;
                                results.push({
                                    题号: currentNum,
                                    期望: targetLetter,
                                    状态: r.ok ? '✅ 正确' : `❌ 错误 (当前${r.actual || '空'})`,
                                    选项内容: ''
                                });
                            }
                        }

                        // 页面已自己翻到下一题：此时再点「下一题」会跳过一题
                        if (advanced) {
                            progress('⏭️ 页面已自动进入下一题，不再点击「下一题」', 'info');
                            await wait(400);
                            continue;
                        }

                        const nextBtn = getActionBtn('下一题');
                        const saveBtn = getActionBtn('保存');

                        if (nextBtn && !nextBtn.disabled) {
                            const before = getCurrentVisibleNum();
                            nextBtn.click();
                            const after = await waitNumChange(before);
                            if (!after || after === before) {
                                progress('⚠️ 点击「下一题」后题号未变化，流程结束', 'warn');
                                const sb = getActionBtn('保存');
                                if (sb) {
                                    sb.click();
                                    progress('💾 已点击【保存】，等待写入…', 'info');
                                    await wait(1200);
                                }
                                break;
                            }
                        } else if (saveBtn) {
                            saveBtn.click();
                            progress('💾 已点击【保存】，等待写入…', 'info');
                            await wait(1200);
                            break;
                        } else {
                            progress('⚠️ 没有找到下一题或保存按钮，流程提前结束', 'warn');
                            break;
                        }
                    }
                    return results;
                }

                async function autoAnswerAndSave(answers, onProgress) {
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };

                    if (!document.querySelectorAll('.examPaper_subject').length) {
                        return {ok: false, msg: '未找到题目（.examPaper_subject），请确认答题页已加载'};
                    }

                    await rewindToFirst(onProgress);
                    const results = await answerWalk(answers, null, onProgress);

                    // 逐题校验已在作答时完成，这里只汇总，不再倒回第一题遍历检测（需要时可点「🔍 检测」）
                    const total = results.length;
                    const successCount = results.filter(r => r.状态.indexOf('✅') === 0).length;
                    progress(`🔍 逐题复核完成：✅ ${successCount} / ${total}`, total && successCount === total ? 'success' : 'warn');
                    logFailedResults(results, progress);
                    return {ok: true, results, successCount, total, allGood: total > 0 && successCount === total};
                }

                /* ================== 9. 面板（单面板 + 标签切换） ================== */
                let panel = null, bodyEl = null;
                let statusMsg = null, answerTa = null, titleEl = null;
                let tabAiBtn = null, tabManualBtn = null;
                let mainAiBtn = null, mainPasteBtn = null, copyBtn = null, checkBtn = null;
                let mode = 'ai';
                let compact = true, compactBtn = null;   // 默认以精简模式启动
                // 精简面板的进度元素：状态胶囊 / 百分比 / 进度条 / 完成数
                let compactStatusEl = null, compactFillEl = null, compactCardEl = null;
                let compactPctNumEl = null, compactChipEl = null;
                let compactCountEl = null, compactRestEl = null;
                let lastStatus = {msg: '待开始', type: ''};
                // 完成进度模型：total 在开始答题时写入，done 由状态文案推算
                const compactProgress = {done: 0, total: 0, pct: 0, kind: 'idle'};
                let compactPctRaf = 0;

                // 精简模式下，把每条日志变成页面上的消息气泡（不再显示面板日志区）
                Logger.setAddListener(function (item) {
                    if (compact) notify(item.type, item.msg);
                });
                let running = false, checking = false;
                let lastData = null, lastUrl = '';
                let lastAiAnswers = null;

                function setStatus(msg, type) {
                    Logger.add(type || 'info', msg);
                    lastStatus = {msg: msg, type: type || ''};
                    updateCompactProgress(msg, type);
                    if (!statusMsg) return;
                    statusMsg.textContent = msg;
                    statusMsg.className = 'zai-status' + (type ? ' zai-status-' + type : '');
                }

                // 精简面板里的「完成进度」：状态胶囊 + 百分比 + 进度条 + 已完成题数
                function setCompactTotal(n) {
                    const total = Number(n) || 0;
                    if (total > 0) compactProgress.total = total;
                    renderCompactProgress(false);
                }

                function resetCompactProgress() {
                    compactProgress.done = 0;
                    compactProgress.total = 0;
                    compactProgress.pct = 0;
                    compactProgress.kind = 'idle';
                    renderCompactProgress(false);
                }

                // 百分比数字做一次补间，避免数字生硬跳变
                function tweenCompactPct(to, animate) {
                    if (!compactPctNumEl) return;
                    const target = Math.max(0, Math.min(100, Math.round(to)));
                    const from = Number(compactPctNumEl.textContent) || 0;
                    if (compactPctRaf) cancelAnimationFrame(compactPctRaf);
                    compactPctRaf = 0;
                    if (!animate || from === target || prefersReducedMotion()) {
                        compactPctNumEl.textContent = String(target);
                        return;
                    }
                    const started = (window.performance || Date).now();
                    const step = function (now) {
                        const p = Math.min(1, (now - started) / 320);
                        const eased = 1 - Math.pow(1 - p, 3);
                        compactPctNumEl.textContent = String(Math.round(from + (target - from) * eased));
                        if (p < 1) compactPctRaf = requestAnimationFrame(step);
                        else compactPctRaf = 0;
                    };
                    compactPctRaf = requestAnimationFrame(step);
                }

                function renderCompactProgress(animatePct) {
                    const st = compactProgress;
                    if (compactFillEl) {
                        if (st.kind === 'ok') {
                            compactFillEl.className = 'zai-cprogress-fill zai-cprogress-fill--ok';
                            compactFillEl.style.width = '100%';
                        } else if (st.kind === 'err') {
                            compactFillEl.className = 'zai-cprogress-fill zai-cprogress-fill--err';
                            compactFillEl.style.width = Math.max(st.pct, 6) + '%';
                        } else if (st.kind === 'run' && !st.total) {
                            compactFillEl.className = 'zai-cprogress-fill zai-cprogress-fill--indet';
                            compactFillEl.style.width = '40%';
                        } else {
                            compactFillEl.className = 'zai-cprogress-fill' + (st.kind === 'run' ? ' zai-cprogress-fill--run' : '');
                            compactFillEl.style.width = (st.pct > 0 ? Math.max(st.pct, 4) : 0) + '%';
                        }
                    }
                    if (compactChipEl) {
                        const labels = {idle: '待开始', run: '进行中', ok: '已完成', err: '出错'};
                        compactChipEl.textContent = labels[st.kind] || '待开始';
                        compactChipEl.className = 'zai-cp-chip' + (st.kind === 'idle' ? '' : ' zai-cp-chip--' + st.kind);
                    }
                    if (compactPctNumEl) {
                        const known = st.total > 0 || st.kind === 'ok' || st.kind === 'err';
                        if (known) {
                            compactPctNumEl.classList.remove('zai-cp-pct-num--dim');
                            tweenCompactPct(st.kind === 'ok' ? 100 : st.pct, animatePct);
                        } else {
                            compactPctNumEl.textContent = '··';
                            compactPctNumEl.classList.add('zai-cp-pct-num--dim');
                        }
                    }
                    if (compactCountEl) {
                        compactCountEl.textContent = st.total > 0
                            ? '已完成 ' + st.done + ' / ' + st.total + ' 题'
                            : (st.kind === 'run' ? '正在处理…' : '尚未开始');
                    }
                    if (compactRestEl) {
                        compactRestEl.textContent = st.total > 0
                            ? (st.done >= st.total ? '全部完成' : '剩余 ' + (st.total - st.done) + ' 题')
                            : '';
                    }
                }

                // 从状态文案推算完成进度：既认 “3 / 10” 这种完成数，也认 “第 3 题” 这种当前题号
                function updateCompactProgress(msg, type) {
                    if (!compactStatusEl) return;
                    const text = stripEmoji(msg);
                    compactStatusEl.textContent = text || '等待开始';
                    compactStatusEl.className = 'zai-cp-label' + (type ? ' zai-cp-' + type : '');

                    const st = compactProgress;
                    const cnt = /(\d+)\s*\/\s*(\d+)/.exec(text);
                    if (cnt && Number(cnt[2]) > 0 && /(完成|核对|校验|检测|作答|通过)/.test(text)) {
                        st.total = Number(cnt[2]);
                        st.done = Math.max(st.done, Math.min(Number(cnt[1]), st.total));
                    }
                    const qm = /第\s*(\d+)\s*题/.exec(text);
                    if (qm && st.total > 0) {
                        const n = Number(qm[1]);
                        const settled = /(通过|正确|已保存|完成)/.test(text);
                        st.done = Math.max(st.done, Math.min(st.total, settled ? n : n - 1));
                    }

                    const busy = running || checking || (typeof catching !== 'undefined' && catching);
                    const isFinal = /(逐题复核完成|逐题校验完成|检测完成|全部完成|已保存|答题完成)/.test(text);
                    if (type === 'error') st.kind = 'err';
                    else if ((st.total > 0 && st.done >= st.total) || (type === 'success' && isFinal)) st.kind = 'ok';
                    else if (busy || st.done > 0) st.kind = 'run';
                    else st.kind = 'idle';

                    st.pct = st.total > 0 ? Math.round(st.done / st.total * 100) : 0;
                    if (st.kind === 'ok') st.pct = 100;
                    renderCompactProgress(true);

                    // 出错时轻微抖动一次，提示异常
                    if (st.kind === 'err' && compactCardEl) {
                        const card = compactCardEl;
                        card.classList.remove('zai-cp-shake');
                        void card.offsetWidth;
                        card.classList.add('zai-cp-shake');
                        setTimeout(function () {
                            card.classList.remove('zai-cp-shake');
                        }, 480);
                    }
                }

                // 新一轮开始前清掉上一轮留在底部的答案与状态，避免误看成这次的结果
                function resetFooter() {
                    if (answerTa) answerTa.value = '';
                    if (statusMsg) {
                        statusMsg.textContent = '';
                        statusMsg.className = 'zai-status';
                    }
                    resetCompactProgress();
                }

                function setButtonsBusy(busy) {
                    [mainAiBtn, mainPasteBtn, copyBtn, checkBtn, tabAiBtn, tabManualBtn].forEach(btn => {
                        if (btn) btn.disabled = busy;
                    });
                    if (mainAiBtn) mainAiBtn.textContent = busy ? '执行中…' : '开始答题';
                    if (mainPasteBtn) mainPasteBtn.textContent = busy ? '执行中…' : '粘贴答题';
                    if (checkBtn) checkBtn.textContent = busy ? '执行中…' : '检测';
                }

                function updateTitle(hw) {
                    if (!titleEl) return;
                    titleEl.textContent = '共享课作业助手' + (hw && hw.questions && hw.questions.length ? ' · ' + hw.questions.length + ' 题' : '');
                }

                // 按当前标签显示/隐藏对应元素，避免堆叠多余控件
                function updateModeUI() {
                    const isAi = mode === 'ai';
                    if (tabAiBtn) {
                        tabAiBtn.className = 'zai-tab' + (isAi ? ' zai-tab-active' : '');
                        tabAiBtn.setAttribute('aria-selected', isAi ? 'true' : 'false');
                    }
                    if (tabManualBtn) {
                        tabManualBtn.className = 'zai-tab' + (isAi ? '' : ' zai-tab-active');
                        tabManualBtn.setAttribute('aria-selected', isAi ? 'false' : 'true');
                    }
                    if (mainAiBtn) mainAiBtn.style.display = isAi ? '' : 'none';
                    if (mainPasteBtn) mainPasteBtn.style.display = isAi ? 'none' : '';
                    if (copyBtn) copyBtn.style.display = isAi ? 'none' : '';
                    // 答案框两种模式都可见：AI 模式展示传回的答案（只读），手动模式可编辑
                    if (answerTa) {
                        answerTa.readOnly = isAi;
                        answerTa.placeholder = isAi
                            ? 'AI 传回的答案（切到「手动填入」可编辑）'
                            : '粘贴 AI 返回的答案 JSON，例如：{"1":"B","2":"A","3":"B"}';
                    }
                }

                function switchMode(next) {
                    if (next === mode) return;
                    if (running || checking) {
                        setStatus('执行中，暂不能切换标签', 'warn');
                        return;
                    }
                    mode = next;
                    updateModeUI();
                    renderView();
                    setStatus(next === 'ai'
                        ? 'AI 模式：点「开始答题」自动获取答案并作答保存'
                        : '手动模式：粘贴答案 JSON 后点「粘贴答题」', 'info');
                }

                // 精简模式：只保留 AI 自动与「开始答题」，日志改为消息形式内嵌显示
                // 仅切换前端显示，运行中也可随时切换；切换后固定为 AI 自动模式
                function toggleCompact() {
                    compact = !compact;
                    if (compact) mode = 'ai';
                    if (panel) panel.classList.toggle('zai-compact', compact);
                    if (compactBtn) {
                        compactBtn.textContent = compact ? '完整模式' : '精简模式';
                        compactBtn.title = compact ? '返回完整面板' : '切换到精简模式（仅保留开始答题）';
                    }
                    updateModeUI();
                    // 进入精简时立刻补上当前进度，避免空白
                    if (compact) updateCompactProgress(lastStatus.msg, lastStatus.type);
                    // 运行中不重渲染题目区，避免打断进行中的流程展示
                    if (!running && !checking) renderView();
                }

                function createPanel() {
                    if (panel) return;
                    injectStyle();

                    panel = h('div', 'zai-panel');
                    if (compact) {
                        mode = 'ai';                        // 精简模式固定 AI 自动
                        panel.classList.add('zai-compact');
                    }

                    const header = h('div', 'zai-header');
                    titleEl = h('span', 'zai-title', '作业助手');
                    const hbtns = h('span', 'zai-hbtns');
                    const noticeBtn = h('button', 'zai-icon-btn zai-icon-btn--wide', '使用前须知');
                    noticeBtn.type = 'button';
                    noticeBtn.title = '查看使用前须知';
                    compactBtn = h('button', 'zai-icon-btn zai-icon-btn--wide', compact ? '完整模式' : '精简模式');
                    compactBtn.type = 'button';
                    compactBtn.title = compact ? '返回完整面板' : '切换到精简模式（仅保留开始答题）';
                    hbtns.appendChild(noticeBtn);
                    hbtns.appendChild(compactBtn);
                    header.appendChild(titleEl);
                    header.appendChild(hbtns);

                    // 标签栏：AI 自动 / 手动填入
                    const tabbar = h('div', 'zai-tabbar');
                    tabAiBtn = h('button', 'zai-tab', 'AI 自动');
                    tabAiBtn.title = '全自动：后台 DeepSeek 获取答案并作答';
                    tabAiBtn.setAttribute('role', 'tab');
                    tabManualBtn = h('button', 'zai-tab', '手动填入');
                    tabManualBtn.title = '手动粘贴答案 JSON 后作答';
                    tabManualBtn.setAttribute('role', 'tab');
                    tabbar.appendChild(tabAiBtn);
                    tabbar.appendChild(tabManualBtn);

                    // 工具栏：按标签显隐，避免多余控件
                    const toolbar = h('div', 'zai-toolbar');
                    mainAiBtn = h('button', 'zai-btn zai-btn-primary zai-btn-main', '开始答题');
                    mainAiBtn.title = '自动发送题目给后台 DeepSeek，获取答案并自动作答保存';
                    mainPasteBtn = h('button', 'zai-btn zai-btn-primary', '粘贴答题');
                    mainPasteBtn.title = '按下方答案 JSON 自动作答并保存';
                    copyBtn = h('button', 'zai-btn', '复制给 AI');
                    copyBtn.title = '复制题目文本，去其他 AI 获取答案';
                    checkBtn = h('button', 'zai-btn', '检测');
                    checkBtn.title = '检测当前页面作答是否符合答案';
                    toolbar.appendChild(mainAiBtn);
                    toolbar.appendChild(copyBtn);
                    toolbar.appendChild(mainPasteBtn);
                    toolbar.appendChild(checkBtn);

                    bodyEl = h('div', 'zai-body');
                    bodyEl.appendChild(h('div', 'zai-waiting', '等待 doHomework 请求…'));

                    const footerEl = h('div', 'zai-footer');
                    answerTa = document.createElement('textarea');
                    answerTa.className = 'zai-textarea';
                    answerTa.placeholder = '粘贴 AI 返回的答案 JSON，例如：{"1":"B","2":"A","3":"B"}';
                    const actionRow = h('div', 'zai-action-row');
                    statusMsg = h('span', 'zai-status', '');
                    actionRow.appendChild(statusMsg);
                    footerEl.appendChild(answerTa);
                    footerEl.appendChild(actionRow);

                    // 精简模式的内容区：状态胶囊 + 百分比 + 进度条 + 已完成题数
                    const cprogress = h('div', 'zai-cprogress');
                    compactCardEl = cprogress;
                    const cpTop = h('div', 'zai-cp-top');
                    compactChipEl = h('span', 'zai-cp-chip', '待开始');
                    const cpPct = h('span', 'zai-cp-pct');
                    compactPctNumEl = h('span', 'zai-cp-pct-num zai-cp-pct-num--dim', '··');
                    cpPct.appendChild(compactPctNumEl);
                    cpPct.appendChild(h('span', 'zai-cp-pct-unit', '%'));
                    cpTop.appendChild(compactChipEl);
                    cpTop.appendChild(cpPct);
                    const cpTrack = h('div', 'zai-cprogress-track');
                    compactFillEl = h('div', 'zai-cprogress-fill');
                    cpTrack.appendChild(compactFillEl);
                    compactStatusEl = h('div', 'zai-cp-label', '等待开始');
                    const cpFoot = h('div', 'zai-cp-foot');
                    compactCountEl = h('span', 'zai-cp-count', '尚未开始');
                    compactRestEl = h('span', 'zai-cp-rest', '');
                    cpFoot.appendChild(compactCountEl);
                    cpFoot.appendChild(compactRestEl);
                    cprogress.appendChild(cpTop);
                    cprogress.appendChild(cpTrack);
                    cprogress.appendChild(compactStatusEl);
                    cprogress.appendChild(cpFoot);

                    panel.appendChild(header);
                    panel.appendChild(tabbar);
                    panel.appendChild(toolbar);
                    panel.appendChild(cprogress);
                    panel.appendChild(bodyEl);
                    panel.appendChild(footerEl);
                    const logEl = Logger.createSection();
                    panel.appendChild(logEl);
                    (document.body || document.documentElement).appendChild(panel);
                    if (compact) updateCompactProgress(lastStatus.msg, lastStatus.type);

                    noticeBtn.addEventListener('click', e => {
                        e.stopPropagation();
                        openNotice();
                    });
                    compactBtn.addEventListener('click', e => {
                        e.stopPropagation();
                        toggleCompact();
                    });
                    tabAiBtn.addEventListener('click', () => switchMode('ai'));
                    tabManualBtn.addEventListener('click', () => switchMode('manual'));
                    mainAiBtn.addEventListener('click', onAiAutoAnswer);
                    mainPasteBtn.addEventListener('click', onPasteAnswer);
                    copyBtn.addEventListener('click', () => {
                        const text = buildAIText();
                        if (!text) {
                            copyBtn.textContent = '暂无数据';
                            setTimeout(() => {
                                copyBtn.textContent = '复制给 AI';
                            }, 1200);
                            return;
                        }
                        copyText(text);
                        copyBtn.textContent = '已复制';
                        setTimeout(() => {
                            copyBtn.textContent = '复制给 AI';
                        }, 1200);
                    });
                    checkBtn.addEventListener('click', onManualCheck);

                    updateModeUI();
                    makeDraggable(panel, header);
                }

                /* ================== 10. AI 自动答题（AI 界面主流程） ================== */
                async function onAiAutoAnswer() {
                    if (running) return;
                    // 清空上一轮留在底部的答案与状态
                    resetFooter();
                    if (!lastData) {
                        setStatus('尚未捕获到作业数据，请先进入作业答题页', 'warn');
                        return;
                    }
                    if (!document.querySelectorAll('.examPaper_subject').length) {
                        setStatus('未找到题目（.examPaper_subject），请确认答题页已加载', 'warn');
                        return;
                    }
                    const text = buildAIText();
                    if (!text) {
                        setStatus('题目文本构建失败', 'error');
                        return;
                    }

                    // 题量：供面板侧兜底判定使用（答案数不足时继续等，避免采信半截 JSON）
                    let expectedCount = 0;
                    try {
                        const hw = parseHomework(lastData);
                        expectedCount = hw && hw.questions ? hw.questions.length : 0;
                    } catch (e) {
                    }
                    setCompactTotal(expectedCount);

                    running = true;
                    setButtonsBusy(true);
                    setStatus('🤖 正在联系后台 DeepSeek…', 'info');

                    let res = null;
                    for (let attempt = 1; attempt <= 2; attempt++) {
                        try {
                            res = await ds.askDeepSeek(text, {
                                timeoutMs: CONFIG.aiTimeoutMs,
                                expectedCount: expectedCount,
                                onProgress: function (msg) {
                                    setStatus(msg, 'info');
                                }
                            });
                        } catch (e) {
                            res = {error: '请求失败：' + ((e && e.message) || e)};
                        }
                        if (res && res.answers) break;
                        if (attempt === 1) {
                            setStatus('⚠️ ' + ((res && res.error) || 'AI 未返回有效结果') + '，正在自动重试一次…', 'warn');
                            await new Promise(r => setTimeout(r, 1500));
                        }
                    }

                    if (!res || !res.answers) {
                        setStatus((res && res.error) || 'AI 作答失败', 'error');
                        running = false;
                        setButtonsBusy(false);
                        return;
                    }

                    const answers = res.answers;
                    lastAiAnswers = answers;
                    if (answerTa) answerTa.value = JSON.stringify(answers);
                    console.log('🤖 AI 返回答案:', answers);
                    setStatus('✅ AI 已返回 ' + Object.keys(answers).length + ' 个答案，开始自动作答…', 'success');

                    try {
                        const r = await autoAnswerAndSave(answers, (msg, type) => setStatus(msg, type));
                        if (!r.ok) {
                            setStatus(r.msg, 'error');
                            return;
                        }
                        console.table(r.results);
                        setStatus(
                            `逐题校验完成：✅ ${r.successCount} / ${r.total}` + (r.allGood ? '，请手动点提交作业' : '，不达标题见 console.table 或点「🔍 检测」复查'),
                            r.allGood ? 'success' : 'error'
                        );
                        console.log(
                            `%c${r.allGood ? '🎉 全部正确并保存成功' : '⚠️ 存在异常'} ｜ 正确 ${r.successCount} / 共 ${r.total}`,
                            `font-weight:bold;font-size:13px;color:${r.allGood ? '#389e0d' : '#d4380d'}`
                        );
                        if (r.allGood) {
                            console.log('%c👉 接下来请手动点击页面右上角的【提交作业】按钮完成作业！', 'color:#fa8c16;font-weight:bold;font-size:15px;');
                        } else {
                            console.log('%c👉 部分题目可能没保存成功，请检查上方表格中的错误项', 'color:#d4380d;font-weight:bold;');
                        }
                    } catch (e) {
                        setStatus('执行失败：' + ((e && e.message) || e), 'error');
                        console.error('[自动答题] 异常', e);
                    } finally {
                        running = false;
                        setButtonsBusy(false);
                    }
                }

                /* ================== 11. 粘贴答案答题（手动界面流程） ================== */
                async function onPasteAnswer() {
                    if (running) return;
                    if (!answerTa) {
                        setStatus('手动界面未打开', 'warn');
                        return;
                    }
                    const raw = (answerTa.value || '').trim();
                    if (!raw) {
                        setStatus('请先粘贴 AI 返回的答案 JSON', 'warn');
                        answerTa.focus();
                        return;
                    }
                    const answers = extractAnswersFromText(raw);
                    if (!answers || !Object.keys(answers).length) {
                        setStatus('未能从文本中解析出有效答案（需为 {"题号":"字母"}）', 'error');
                        return;
                    }

                    const answerCount = Object.keys(answers).length;
                    lastAiAnswers = answers;
                    console.log('🔍 已解析答案:', answers);

                    running = true;
                    setButtonsBusy(true);
                    setStatus(`开始执行（${answerCount} 个答案），请勿关闭页面…`, 'info');

                    try {
                        const r = await autoAnswerAndSave(answers, (msg, type) => setStatus(msg, type));
                        if (!r.ok) {
                            setStatus(r.msg, 'error');
                            return;
                        }
                        console.table(r.results);
                        setStatus(
                            `逐题校验完成：✅ ${r.successCount} / ${r.total}` + (r.allGood ? '，请手动点提交作业' : '，不达标题见 console.table 或点「🔍 检测」复查'),
                            r.allGood ? 'success' : 'error'
                        );
                        if (r.allGood) {
                            console.log('%c👉 接下来请手动点击页面右上角的【提交作业】按钮完成作业！', 'color:#fa8c16;font-weight:bold;font-size:15px;');
                        }
                    } catch (e) {
                        setStatus('执行失败：' + ((e && e.message) || e), 'error');
                        console.error('[自动答题] 异常', e);
                    } finally {
                        running = false;
                        setButtonsBusy(false);
                    }
                }

                /* ================== 12. 手动检测 ================== */
                function renderCheckReport(v) {
                    if (!bodyEl) return;
                    const old = document.getElementById('zai-check-report');
                    if (old) old.remove();
                    const box = h('div', 'zai-report');
                    box.id = 'zai-check-report';
                    box.appendChild(h('div', 'zai-report-title',
                        '🔍 检测报告：✅ ' + v.successCount + ' / ' + v.total + (v.successCount === v.total ? '（全部达标）' : '（存在不达标）')));
                    v.results.forEach(r => {
                        const row = h('div', 'zai-report-row');
                        row.appendChild(h('span', 'zai-report-num', '第 ' + r.题号 + ' 题'));
                        const ok = r.状态.indexOf('✅') === 0;
                        const noAnswer = r.状态.indexOf('❌ 未作答') === 0;
                        const cls = ok ? 'zai-report-ok' : (noAnswer ? 'zai-report-warn' : 'zai-report-bad');
                        row.appendChild(h('span', cls, '期望 ' + r.期望 + ' → ' + r.状态 + (r.选项内容 ? '（' + r.选项内容 + '）' : '')));
                        box.appendChild(row);
                    });
                    bodyEl.insertBefore(box, bodyEl.firstChild);
                }

                async function onManualCheck() {
                    if (running) {
                        setStatus('自动答题执行中，请等待结束后再检测', 'warn');
                        return;
                    }
                    if (checking) return;

                    // 答案来源：优先文本框粘贴的内容，其次最近一次 AI 返回的答案
                    let answers = null;
                    const raw = (answerTa && answerTa.value || '').trim();
                    if (raw) {
                        const parsed = extractAnswersFromText(raw);
                        if (parsed && Object.keys(parsed).length) answers = parsed;
                    }
                    if (!answers && lastAiAnswers) answers = lastAiAnswers;

                    if (!answers || !Object.keys(answers).length) {
                        setStatus('请先让 AI 答题，或粘贴答案 JSON 后再检测', 'warn');
                        return;
                    }
                    if (!document.querySelectorAll('.examPaper_subject').length) {
                        setStatus('未找到题目（.examPaper_subject），请确认在答题页', 'warn');
                        return;
                    }

                    checking = true;
                    setButtonsBusy(true);
                    if (checkBtn) checkBtn.textContent = '⏳ 检测中…';
                    setStatus('🔍 正在检测当前作答情况…', 'info');

                    try {
                        await new Promise(r => setTimeout(r, 200));
                        const v = await verifyWithRetry(answers, (msg, type) => setStatus(msg, type));
                        renderCheckReport(v);
                        console.table(v.results);
                        const allGood = v.successCount === v.total;
                        setStatus(
                            '检测完成：✅ ' + v.successCount + ' / ' + v.total + (allGood ? '，全部达标' : '，不达标的题可点「🚀 开始答题」或「▶ 粘贴答题」修正'),
                            allGood ? 'success' : 'warn'
                        );
                    } catch (e) {
                        setStatus('检测失败：' + ((e && e.message) || e), 'error');
                        console.error('[检测] 异常', e);
                    } finally {
                        checking = false;
                        setButtonsBusy(false);
                    }
                }

                /* ================== 12.5 渲染（来自 1.js） ================== */
                function renderView() {
                    if (!bodyEl) return;
                    bodyEl.innerHTML = '';
                    if (!lastData) {
                        bodyEl.appendChild(h('div', 'zai-waiting', '等待 doHomework 请求…'));
                        return;
                    }
                    const hw = parseHomework(lastData);
                    if (!hw) {
                        bodyEl.appendChild(h('div', 'zai-error', '响应不是预期的 doHomework 结构'));
                        return;
                    }
                    updateTitle(hw);
                    renderParsed(hw);
                }

                function renderParsed(hw) {
                    const sum = h('div', 'zai-summary');
                    sum.appendChild(h('div', 'zai-summary-title', hw.title || '（未命名作业）'));
                    if (hw.course) sum.appendChild(h('div', '', '课程：' + hw.course));
                    if (hw.chapter) sum.appendChild(h('div', '', '章节：' + hw.chapter));
                    const meta = [];
                    if (hw.problemNum != null) meta.push('题量 ' + hw.problemNum);
                    if (hw.totalScore != null) meta.push('总分 ' + hw.totalScore);
                    if (hw.endTime) meta.push('截止 ' + hw.endTime);
                    if (meta.length) sum.appendChild(h('div', 'zai-summary-meta', meta.join('  |  ')));
                    bodyEl.appendChild(sum);
                    if (lastUrl) bodyEl.appendChild(h('div', 'zai-url', '接口：' + lastUrl));
                    if (!hw.questions.length) {
                        bodyEl.appendChild(h('div', 'zai-error', '未解析到题目'));
                        return;
                    }
                    hw.questions.forEach(q => bodyEl.appendChild(renderQuestionCard(q, '')));
                }

                function renderQuestionCard(q, prefix) {
                    const no = prefix ? `${prefix}-${q.index}` : String(q.index);
                    const card = h('div', 'zai-card');
                    const head = h('div', 'zai-card-head');
                    head.appendChild(h('span', 'zai-card-num', '第 ' + no + ' 题'));
                    const tags = h('span', 'zai-card-tags');
                    tags.appendChild(h('span', 'zai-tag', q.typeName));
                    if (q.score != null && q.score !== '') tags.appendChild(h('span', 'zai-score', q.score + ' 分'));
                    head.appendChild(tags);
                    card.appendChild(head);
                    card.appendChild(h('div', 'zai-stem', q.stem));
                    if (q.options.length) {
                        const box = h('div', 'zai-options');
                        q.options.forEach(o => {
                            const row = h('div', 'zai-option');
                            row.appendChild(h('span', 'zai-option-label', o.label + '.'));
                            row.appendChild(h('span', 'zai-option-content', o.content));
                            box.appendChild(row);
                        });
                        card.appendChild(box);
                    }
                    if (q.children.length) {
                        const sub = h('div', 'zai-sub');
                        q.children.forEach(c => sub.appendChild(renderQuestionCard(c, no)));
                        card.appendChild(sub);
                    }
                    return card;
                }

                /* ================== 13. 构建 AI 文本（来自 1.js） ================== */
                function appendQuestionLines(lines, q, prefix) {
                    const no = prefix ? `${prefix}-${q.index}` : String(q.index);
                    const scorePart = (q.score != null && q.score !== '') ? ` ${q.score}分` : '';
                    lines.push(`${no}. [${q.typeName}${scorePart}] ${q.stem}`);
                    q.options.forEach(o => lines.push(`   ${o.label}. ${o.content}`));
                    if (q.children.length) q.children.forEach(c => appendQuestionLines(lines, c, no));
                }

                function buildAIText() {
                    if (!lastData) return '';
                    const hw = parseHomework(lastData);
                    if (!hw) return '';
                    const lines = [];
                    lines.push(AI_PROMPT);
                    lines.push('');
                    lines.push('========== 题目开始 ==========');
                    lines.push('作业名称：' + (hw.title || '未命名作业'));
                    if (hw.course) lines.push('课程：' + hw.course);
                    if (hw.chapter) lines.push('章节：' + hw.chapter);
                    const meta = [];
                    if (hw.problemNum != null) meta.push('共 ' + hw.problemNum + ' 题');
                    if (hw.totalScore != null) meta.push('总分 ' + hw.totalScore);
                    if (meta.length) lines.push(meta.join(' | '));
                    lines.push('');
                    hw.questions.forEach(q => {
                        appendQuestionLines(lines, q, '');
                        lines.push('');
                    });
                    lines.push('========== 题目结束 ==========');
                    lines.push('');
                    lines.push('请先仔细思考、反复打磨每一道题，然后只输出 {"题号": 答案} 形式的最终 JSON：选择题/判断题给选项字母，填空题给精确答案（多个空用数组），问答题给结构化且专业具体的答案。填空与问答必须写到可判分的程度，不能留空；除这个 JSON 外不要输出任何说明。');
                    return lines.join('\n');
                }

                /* ================== 14. 拦截（来自 1.js） ================== */
                function isTarget(url) {
                    if (!url) return false;
                    try {
                        const u = new URL(url, location.href);
                        return u.hostname === TARGET_HOST && u.pathname === TARGET_PATH;
                    } catch (e) {
                        return false;
                    }
                }

                function handleResponse(data, url) {
                    lastData = data;
                    lastUrl = url;
                    if (isTargetRoute()) {
                        createPanel();
                        renderView();
                    }
                }

                function hookFetch(w) {
                    if (!w || typeof w.fetch !== 'function') return;
                    const orig = w.fetch;
                    const wrapped = disguise(new Proxy(orig, {
                        apply(target, thisArg, args) {
                            const input = args[0];
                            const url = typeof input === 'string' ? input : (input && input.url) || '';
                            const p = Reflect.apply(target, thisArg, args);
                            if (isTarget(url) && p && typeof p.then === 'function') {
                                p.then(res => {
                                    try {
                                        res.clone().text().then(t => {
                                            let data;
                                            try {
                                                data = JSON.parse(t);
                                            } catch (e) {
                                                data = null;
                                            }
                                            if (data) handleResponse(data, url);
                                        }).catch(() => {
                                        });
                                    } catch (e) {
                                    }
                                }).catch(() => {
                                });
                            }
                            return p;
                        }
                    }));
                    w.fetch = wrapped;
                }

                function hookXHR(w) {
                    if (!w || !w.XMLHttpRequest) return;
                    const X = w.XMLHttpRequest;
                    const origOpen = X.prototype.open;
                    const origSend = X.prototype.send;
                    const URL_KEY = Symbol('u');
                    const newOpen = disguise(new Proxy(origOpen, {
                        apply(target, thisArg, args) {
                            try {
                                thisArg[URL_KEY] = args[1];
                            } catch (e) {
                            }
                            return Reflect.apply(target, thisArg, args);
                        }
                    }));
                    const newSend = disguise(new Proxy(origSend, {
                        apply(target, thisArg, args) {
                            const url = thisArg[URL_KEY] || '';
                            if (isTarget(url)) {
                                try {
                                    thisArg.addEventListener('load', function () {
                                        try {
                                            const text = thisArg.responseText || '';
                                            let data;
                                            try {
                                                data = JSON.parse(text);
                                            } catch (e) {
                                                data = null;
                                            }
                                            if (data) handleResponse(data, url);
                                        } catch (e) {
                                        }
                                    });
                                } catch (e) {
                                }
                            }
                            return Reflect.apply(target, thisArg, args);
                        }
                    }));
                    X.prototype.open = newOpen;
                    X.prototype.send = newSend;
                }

                /* ================== 15. 路由判断与启动（来自 1.js + 菜单命令） ================== */
                function isTargetRoute() {
                    return location.hash.indexOf('dohomework') !== -1;
                }

                hookFetch(pageWindow);
                hookXHR(pageWindow);
                ds.initRelayChannels();

                function syncPanelWithRoute() {
                    if (isTargetRoute()) {
                        if (!panel) createPanel();
                        else panel.style.display = '';
                        if (lastData) renderView();
                    } else {
                        if (panel) panel.style.display = 'none';
                    }
                }

                function bootSync() {
                    syncPanelWithRoute();
                    setTimeout(syncPanelWithRoute, 300);
                    setTimeout(syncPanelWithRoute, 1000);
                    setTimeout(syncPanelWithRoute, 2000);
                }

                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', bootSync);
                } else {
                    bootSync();
                }
                pageWindow.addEventListener('hashchange', syncPanelWithRoute);

                if (typeof GM_registerMenuCommand === 'function') {
                    GM_registerMenuCommand('启动后台 AI 助手（DeepSeek）', function () {
                        if (ds.isLocalWorkerOpen()) {
                            alert('后台助手已在运行（本页打开的），无需重复启动。');
                            return;
                        }
                        if (ds.isWorkerAlive()) {
                            alert('后台助手已在其他标签页运行，无需重复启动。');
                            return;
                        }
                        if (ds.openWorkerTab()) {
                            alert('后台助手已启动。\n\n' +
                                '· 新标签已在后台打开（不会切走你的当前页面）；\n' +
                                '· 请在该标签页登录 DeepSeek；\n' +
                                '· 它会在 3 分钟无任务后自动关闭。\n\n' +
                                '现在点击「🤖 AI 自动答题」试试吧。');
                        } else {
                            alert('启动失败：浏览器拦截了弹窗。\n\n' +
                                '请在 Tampermonkey 管理面板 → 本脚本 → 设置里确认已授权「打开标签页」。');
                        }
                    });
                }

                log('答题页部分已加载');

            })();
        }

        /* ============================================================
         *  C. 翻转课作业页（atHomeworkExam，原 5.js 逻辑：遍历抓取题目）
         * ============================================================ */
        else if (isFzPage) {
            (function () {
                const ds = createDeepSeekClient('fz');

                /* ================== 2. 翻转课页面 DOM 读取（来自 4.js，去掉文件导入导出） ================== */
                // 已抓取的题目（标准化为与 3.js 一致的结构，复用渲染与提示词构建）
                let caughtQuestions = [];
                let catching = false;


                // 当前可见的题目框（页面一次只展示一题）
                function getVisibleBox() {
                    const boxes = Array.from(document.querySelectorAll('.questionBox'));
                    const visible = boxes.find(b => {
                        let p = b, hidden = false;
                        while (p) {
                            if (p.style && p.style.display === 'none') {
                                hidden = true;
                                break;
                            }
                            p = p.parentElement;
                        }
                        return !hidden && b.offsetParent !== null;
                    });
                    return visible || boxes[0] || null;
                }

                // 当前题号（来自标题中的数字）
                function getCurrentNum() {
                    const box = getVisibleBox();
                    if (!box) return null;
                    const tit = (box.querySelector('.questionTit')?.textContent || '').trim();
                    const m = tit.match(/\d+/);
                    return m ? m[0] : null;
                }

                // 题型：单选 / 多选 / 判断 / 填空 / 问答
                // 标题形如「1.【单选题】 (5分)」「9.【填空主观题】」「14.【问答题】」
                function detectTypeName(tit, box) {
                    const t = String(tit || '');
                    if (/填空|主观/.test(t)) return '填空题';
                    if (/问答|简答|论述|名词解释|分析|计算/.test(t)) return '问答题';
                    if (/多选/.test(t)) return '多选题';
                    if (/判断/.test(t)) return '判断题';
                    if (/单选/.test(t)) return '单选题';
                    if (box) {
                        if (box.querySelector('.el-checkbox-group')) return '多选题';
                        if (!box.querySelector('.el-radio')) {
                            if (box.querySelector('textarea')) return '问答题';
                            if (readTextFields(box).length) return '填空题';
                        }
                    }
                    return '单选题';
                }

                // 文本类题型（填空 / 问答等主观题）：答案为文字而非选项字母
                const TEXT_TYPE_RE = /填空|问答|简答|论述|主观|名词解释|分析|计算|案例/;

                function isTextQuestion(typeName) {
                    return TEXT_TYPE_RE.test(String(typeName || ''));
                }

                // 读取当前题的选项（含元素引用，供点击使用）
                function readOptionEls(box) {
                    if (!box) return [];
                    const radios = Array.from(box.querySelectorAll('.el-radio'));
                    const checks = Array.from(box.querySelectorAll('.el-checkbox'));
                    const els = radios.length ? radios : checks;
                    return els.map((el, idx) => {
                        const labelEl = el.querySelector('.el-radio__label, .el-checkbox__label');
                        const labelText = (labelEl?.innerText || '').trim();
                        const contentEl = el.querySelector('.optionContent');
                        const content = (contentEl?.innerText || labelText).trim();
                        let letter = '';
                        const m = labelText.match(/^\s*([A-Za-z])\s*[.、:：\s]?/);
                        if (m) letter = m[1].toUpperCase();
                        if (!letter) letter = String.fromCharCode(65 + idx);
                        return {el, letter, content, labelText};
                    });
                }

                /* ---------- 3.0 填空题 / 问答题：文本输入框读取与写入 ---------- */

                // 读取当前题里的可编辑文本域：填空通常每空一个 input，问答通常是一个 textarea
                function readTextFields(box) {
                    if (!box) return [];
                    const skip = /^(radio|checkbox|hidden|file|submit|button|image|reset|range|color)$/i;
                    const all = Array.from(box.querySelectorAll('textarea, input')).filter(el => {
                        const type = el.tagName === 'TEXTAREA' ? 'textarea' : String(el.type || 'text').toLowerCase();
                        if (skip.test(type)) return false;
                        if (el.disabled || el.readOnly) return false;
                        return true;
                    });
                    const visible = all.filter(el => el.getClientRects().length > 0);
                    return visible.length ? visible : all;
                }

                function readTextValues(box) {
                    return readTextFields(box).map(el => String(el.value || '').trim());
                }

                // 用原生 setter 写值并派发事件，兼容 Vue / Element Plus 的双向绑定
                function setFieldValue(el, value) {
                    const text = String(value == null ? '' : value);
                    const Win = pageWindow || window;
                    try {
                        el.focus();
                    } catch (e) {
                    }
                    const proto = el.tagName === 'TEXTAREA'
                        ? (Win.HTMLTextAreaElement || HTMLTextAreaElement).prototype
                        : (Win.HTMLInputElement || HTMLInputElement).prototype;
                    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (desc && desc.set) desc.set.call(el, text);
                    else el.value = text;
                    ['input', 'change', 'keyup'].forEach(t => {
                        el.dispatchEvent(new Event(t, {bubbles: true, cancelable: true}));
                    });
                    try {
                        el.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
                        el.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: text}));
                    } catch (e) {
                    }
                    try {
                        el.blur();
                    } catch (e) {
                    }
                }

                // 多空答案拆分：数组直接用；字符串按常见分隔符切成多段
                function splitAnswerParts(ans) {
                    if (Array.isArray(ans)) return ans.map(x => String(x).trim()).filter(Boolean);
                    const s = String(ans == null ? '' : ans).trim();
                    if (!s) return [];
                    const parts = s.split(/\s*(?:\|\||｜｜|##|\/\/|\n|\t|；|;)\s*/).map(x => x.trim()).filter(Boolean);
                    return parts.length ? parts : [s];
                }

                function normText(s) {
                    return String(s == null ? '' : s)
                        .replace(/\s+/g, '')
                        .replace(/[，。、；：！？"'“”‘’（）()【】《》\[\]{}.,;:!?]/g, '')
                        .toLowerCase();
                }

                // 文本答案与回读值比对：数量一致时逐空比对，不一致时按包含关系兜底
                function textMatch(expectedParts, actualValues) {
                    const e = (expectedParts || []).map(normText).filter(Boolean);
                    const a = (actualValues || []).map(normText).filter(Boolean);
                    if (!e.length || !a.length) return false;
                    const eq = (x, y) => x === y || (x && y && (x.indexOf(y) !== -1 || y.indexOf(x) !== -1));
                    if (e.length === a.length) return e.every((x, i) => eq(x, a[i]));
                    return e.every(x => a.some(y => eq(x, y)));
                }

                function briefAnswer(v) {
                    const s = Array.isArray(v) ? v.join(' / ') : String(v == null ? '' : v);
                    const one = s.replace(/\s+/g, ' ').trim();
                    return one.length > 40 ? one.slice(0, 40) + '…' : one;
                }

                /**
                 * 把文本答案写入当前题：
                 * - 单个输入框：整段写入（问答题 / 只有一个空的填空题）
                 * - 多个输入框：按空位顺序一一对应；数量不一致时按顺序尽力填并告警
                 */
                async function applyTextAnswerToQuestion(num, ans, onProgress, maxAttempts) {
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    const attempts = maxAttempts || 2;
                    let lastActual = '';

                    for (let attempt = 1; attempt <= attempts; attempt++) {
                        const box = getVisibleBox();
                        if (!box) return {ok: false, actual: '', attempt};
                        const fields = readTextFields(box);
                        if (!fields.length) {
                            progress(`⚠️ 第 ${num} 题为文本题，但未找到输入框，请手动作答`, 'warn');
                            return {ok: false, actual: '', attempt, nofield: true};
                        }

                        const parts = splitAnswerParts(ans);
                        if (!parts.length) {
                            progress(`⚠️ 第 ${num} 题答案为空，跳过`, 'warn');
                            return {ok: false, actual: '', attempt, empty: true};
                        }

                        let values;
                        if (fields.length === 1) {
                            values = [Array.isArray(ans) ? parts.join('；') : String(ans).trim()];
                        } else {
                            values = fields.map((el, i) => (parts[i] != null ? parts[i] : ''));
                            if (parts.length !== fields.length) {
                                progress(`⚠️ 第 ${num} 题有 ${fields.length} 个空，答案 ${parts.length} 段，按顺序尽力填入`, 'warn');
                            }
                        }

                        fields.forEach((el, i) => {
                            const v = values[i] == null ? '' : values[i];
                            if (!v) return;
                            if (String(el.value || '').trim() === v) return;   // 已一致，不重复写
                            setFieldValue(el, v);
                        });

                        await sleep(400);

                        const fields2 = readTextFields(getVisibleBox());
                        const actualValues = fields2.map(el => String(el.value || '').trim());
                        lastActual = actualValues.filter(Boolean).join(' | ');

                        if (lastActual && textMatch(values, actualValues)) {
                            progress(`✅ 第 ${num} 题已填写${fields2.length > 1 ? ' ' + fields2.length + ' 空' : ''}`, 'info');
                            return {ok: true, actual: lastActual, attempt};
                        }
                        if (lastActual) {
                            // 已写入但回读与期望不完全一致（页面可能自动排版/截断），不反复重写
                            progress(`⚠️ 第 ${num} 题已填入内容，但回读与期望不一致，请人工复核`, 'warn');
                            return {ok: true, actual: lastActual, attempt, mismatch: true};
                        }
                        progress(`⚠️ 第 ${num} 题第 ${attempt}/${attempts} 次填写后仍为空`, 'warn');
                        await sleep(600);
                    }
                    return {ok: false, actual: lastActual, attempt: attempts};
                }

                // 文本题的「填完即校验」：写入后延迟回读，失败再补写；页面自动翻页视为完成
                async function applyAndConfirmText(num, ans, onProgress) {
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    const rounds = 2;
                    let lastActual = '';

                    for (let round = 1; round <= rounds; round++) {
                        const r = await applyTextAnswerToQuestion(num, ans, onProgress, 2);
                        if (r.actual) lastActual = r.actual;

                        await sleep(round === 1 ? 500 : 800);

                        const curNum = getCurrentNum();
                        if (curNum && curNum !== String(num)) {
                            progress(`↪️ 页面已切换到第 ${curNum} 题，第 ${num} 题视为完成`, 'info');
                            return {ok: true, actual: lastActual};
                        }
                        if (r.ok) return {ok: true, actual: lastActual || r.actual};
                        if (r.nofield || r.empty) return {ok: false, actual: lastActual};
                        progress(`⚠️ 第 ${num} 题第 ${round}/${rounds} 轮填写未成功，重试…`, 'warn');
                    }
                    return {ok: false, actual: lastActual};
                }

                // 抓取时使用：只取展示数据
                function readQuestionForCatch() {
                    const box = getVisibleBox();
                    if (!box) return null;
                    const tit = (box.querySelector('.questionTit')?.textContent || '').trim();
                    const m = tit.match(/\d+/);
                    if (!m) return null;
                    const num = m[0];
                    const stem = (box.querySelector('.questionContent')?.textContent || '').trim() || '无内容';
                    const typeName = detectTypeName(tit, box);
                    const options = readOptionEls(box).map(o => ({label: o.letter, content: o.content}));
                    const blanks = isTextQuestion(typeName) ? readTextFields(box).length : 0;
                    // 标题形如「14.【问答题】 (10分)」：把分值带给 AI，便于按分值决定要点数量
                    const sm = tit.match(/[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[)）]/);
                    const score = sm ? Number(sm[1]) : null;
                    return {index: num, num: num, stem, typeName, score: score, options, children: [], blanks: blanks};
                }

                // 翻页按钮（下一题 / 上一题），灰色类名为禁用
                function getSwitchBtn(text) {
                    const list = document.querySelectorAll('.Topicswitchingbtn');
                    for (const btn of list) {
                        if ((btn.textContent || '').trim().includes(text)) {
                            const gray = btn.classList.contains('Topicswitchingbtn-gray');
                            return {btn, canClick: !gray};
                        }
                    }
                    return {btn: null, canClick: false};
                }

                /* ================== 3. 选项状态与核对（翻转课版） ================== */

                // 选项是否已选中：优先 input 真实状态（同步），其次 Element Plus 的 is-checked 类
                function isOptChecked(opt) {
                    const input = opt.el.querySelector('input');
                    if (input) return input.checked;
                    return opt.el.classList.contains('is-checked');
                }

                function selectedLetters(options) {
                    return options.filter(isOptChecked).map(o => o.letter).join('');
                }

                function isSameSelection(actual, target) {
                    const t = String(target).toUpperCase().replace(/[^A-Z]/g, '');
                    const a = String(actual).toUpperCase().replace(/[^A-Z]/g, '');
                    return a.length > 0 && a.length === t.length && a.split('').every(ch => t.includes(ch));
                }

                /**
                 * 核对：翻转课页面一次只展示一题，需要从第一题遍历到最后一题逐一读取选中状态。
                 * 全程只读，不修改任何选择。
                 */
                async function verifyWalk(answers, onProgress) {
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    const results = [];
                    let successCount = 0;
                    let guard = 500;

                    await rewindToFirst(onProgress);
                    progress('🔍 开始逐题核对…', 'info');

                    while (guard-- > 0) {
                        const box = getVisibleBox();
                        const num = getCurrentNum();
                        if (box && num) {
                            const tit = (box.querySelector('.questionTit')?.textContent || '').trim();
                            const typeName = detectTypeName(tit, box);
                            const expected = answers[num];
                            let status = '', detail = '';

                            if (isTextQuestion(typeName)) {
                                // 填空题 / 问答题：回读输入框内容与答案比对
                                const values = readTextValues(box).filter(Boolean);
                                const actual = values.join(' | ');
                                const parts = splitAnswerParts(expected);
                                const expectedText = parts.length ? parts.join(' | ') : '无要求';
                                if (!actual) {
                                    status = '❌ 未作答';
                                } else if (!parts.length) {
                                    status = '❌ 无参考答案';
                                    detail = actual;
                                } else if (textMatch(parts, values)) {
                                    status = '✅ 正确';
                                    successCount++;
                                } else {
                                    status = `❌ 错误 (当前${actual.length > 40 ? actual.slice(0, 40) + '…' : actual})`;
                                    detail = actual;
                                }
                                results.push({题号: num, 期望: expectedText, 状态: status, 选项内容: detail});
                                progress(`🔍 第 ${num} 题：${status}`, 'info');
                            } else {
                                const options = readOptionEls(box);
                                const actual = selectedLetters(options);
                                const expectedLetters = answerToLetters(expected);
                                const expectedText = expectedLetters || '无要求';
                                if (!actual) {
                                    status = '❌ 未作答';
                                } else {
                                    const txt = options.filter(isOptChecked).map(o => o.letter + '.' + o.content).join(' / ');
                                    if (expectedLetters && isSameSelection(actual, expectedLetters)) {
                                        status = '✅ 正确';
                                        successCount++;
                                    } else {
                                        status = `❌ 错误 (当前${actual})`;
                                        detail = txt;
                                    }
                                }
                                results.push({题号: num, 期望: expectedText, 状态: status, 选项内容: detail});
                                progress(`🔍 第 ${num} 题：${status}`, 'info');
                            }
                        }

                        const next = getSwitchBtn('下一题');
                        if (!next.btn || !next.canClick) break;
                        next.btn.click();
                        await sleep(700);
                    }
                    return {results, successCount, total: results.length};
                }

                /* ================== 3.5 带延迟补偿的核对 ================== */
                // 点击后页面状态刷新可能有延迟：核对不达标时等待后重新遍历复核，
                // 连续两轮一致才采信，避免把"延迟"误报成"错误"而触发无谓的二次修正。
                async function verifyWithRetry(answers, onProgress, maxRounds) {
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    const rounds = maxRounds || 2;   // 每轮都要遍历全部题目，默认 2 轮
                    let best = null;
                    let prevKey = '';
                    for (let i = 1; i <= rounds; i++) {
                        const v = await verifyWalk(answers, onProgress);
                        if (!best || v.successCount > best.successCount) best = v;
                        const key = v.results.map(r => r.题号 + ':' + r.状态).join('|');
                        if (v.successCount === v.total) return v;
                        if (key === prevKey) return best;
                        prevKey = key;
                        if (i < rounds) {
                            progress(`⏳ 第 ${i} 轮核对：✅ ${v.successCount} / ${v.total}，等待页面状态刷新（约 2.5s）后重新遍历复核…`, 'info');
                            await sleep(2500);
                        }
                    }
                    return best;
                }

                /* ================== 4. 答案匹配与逐题作答（翻转课版：4.js 匹配 + 3.js 预检/重试） ================== */

                // 从答案中提取选项字母（支持 ABC / A,B,C / A、B、C / A. xxx 等）
                function extractLetters(upper) {
                    if (/^[A-Z]([\s,，、;；]*[A-Z])*$/.test(upper)) {
                        return upper.match(/[A-Z]/g) || [];
                    }
                    const m = upper.match(/^([A-Z]+)\s*[.、:：]\s*/);
                    if (m) return m[1].split('');
                    return [];
                }

                // 根据答案文本/字母匹配选项（兼容判断题的 对/错 别名）
                function matchOptions(options, ans) {
                    const raw = String(ans == null ? '' : ans).trim();
                    if (!raw) return [];
                    const upper = raw.toUpperCase().replace(/\s+/g, '');

                    const judgeGroups = [
                        ['正确', '对', '√', 'T', 'TRUE'],
                        ['错误', '错', '×', 'F', 'FALSE'],
                    ];
                    const isJudge = judgeGroups.some(g => g.includes(raw) || g.includes(upper));

                    const textCandidates = new Set();
                    textCandidates.add(raw);
                    textCandidates.add(upper);
                    textCandidates.add(raw.replace(/[\s,，、;；.。:：]+/g, ''));
                    textCandidates.add(upper.replace(/[\s,，、;；.。:：]+/g, ''));
                    if (isJudge) {
                        for (const g of judgeGroups) {
                            if (g.includes(raw) || g.includes(upper)) g.forEach(x => textCandidates.add(x));
                        }
                    }

                    const letterSet = new Set(isJudge ? [] : extractLetters(upper));

                    return options.filter(opt => {
                        if (letterSet.has(opt.letter)) return true;
                        const content = opt.content.toUpperCase().replace(/\s+/g, '');
                        const label = opt.labelText.toUpperCase().replace(/\s+/g, '');
                        for (const c of textCandidates) {
                            if (!c) continue;
                            if (content === c || label === c) return true;
                            if (c.length >= 2 && (content.includes(c) || label.includes(c))) return true;
                        }
                        return false;
                    });
                }

                /**
                 * 对单题执行作答（带预检，最多重试 maxAttempts 次）：
                 * - 先读取当前已选选项，已符合目标 → 跳过，避免二次点击把已写入的选项清掉；
                 * - 单选：点目标项（自动替换旧选择）；多选：取消多余旧选项、再勾选缺失目标项；
                 * - 点完复检，不达标则重试。
                 */
                async function applyAnswerToQuestion(num, ans, onProgress, maxAttempts) {
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    const attempts = maxAttempts || 3;
                    let lastActual = '';

                    for (let attempt = 1; attempt <= attempts; attempt++) {
                        const box = getVisibleBox();
                        if (!box) return {ok: false, actual: '', attempt};
                        const options = readOptionEls(box);
                        if (!options.length) {
                            progress(`⚠️ 第 ${num} 题未找到选项元素`, 'warn');
                            return {ok: false, actual: '', attempt};
                        }

                        const tit = (box.querySelector('.questionTit')?.textContent || '').trim();
                        const isMulti = detectTypeName(tit, box) === '多选题';
                        const targets = matchOptions(options, ans);
                        if (!targets.length) {
                            progress(`⚠️ 第 ${num} 题答案「${ans}」未能匹配到选项，请手动作答`, 'warn');
                            return {ok: false, actual: '', attempt, nomatch: true};
                        }
                        const targetLetters = targets.map(t => t.letter).join('');

                        // 预检：已符合目标直接跳过，防止二次选择出错
                        lastActual = selectedLetters(options);
                        if (isSameSelection(lastActual, targetLetters)) {
                            progress(`⏭️ 第 ${num} 题已是 ${lastActual}，符合 ${targetLetters}，跳过`, 'info');
                            return {ok: true, actual: lastActual, attempt};
                        }

                        if (!isMulti) {
                            // 单选：只点目标项
                            const t = targets[0];
                            if (!isOptChecked(t)) {
                                t.el.click();
                                await sleep(600);
                            }
                        } else {
                            // 多选：只切换"需要变"的项，已对的不重复点击
                            const targetSet = new Set(targets);
                            for (const opt of options) {
                                const checked = isOptChecked(opt);
                                const should = targetSet.has(opt);
                                if (should !== checked) {
                                    opt.el.click();
                                    await sleep(250);
                                }
                            }
                            await sleep(500);
                        }

                        // 复检（重新读取，避免元素引用过期）
                        const box2 = getVisibleBox();
                        const options2 = box2 ? readOptionEls(box2) : [];
                        lastActual = selectedLetters(options2);
                        if (isSameSelection(lastActual, targetLetters)) {
                            progress(`✅ 第 ${num} 题已选择 ${lastActual}`, 'info');
                            return {ok: true, actual: lastActual, attempt};
                        }
                        progress(`⚠️ 第 ${num} 题第 ${attempt}/${attempts} 次尝试后仍不达标（当前 ${lastActual || '空'}，期望 ${targetLetters}）`, 'warn');
                        await sleep(800);
                    }
                    return {ok: false, actual: lastActual, attempt: attempts};
                }

                // 倒回第一题
                async function rewindToFirst(onProgress) {
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    progress('🔄 正在倒回第一题…', 'info');
                    // 优先：直接点击题号列表第一题
                    let firstLi = document.querySelector('.jobclassallnumber-div ul li');
                    if (!firstLi) {
                        await sleep(500);
                        firstLi = document.querySelector('.jobclassallnumber-div ul li');
                    }
                    if (firstLi) {
                        firstLi.click();
                        console.log('已点击第一题');
                        await sleep(700);
                        return;
                    }
                    console.error('未找到第一题，改用连点上一题');
                    // 兜底：连点「上一题」
                    let maxBack = 100;
                    let prev = getSwitchBtn('上一题');
                    while (prev.btn && prev.canClick && maxBack-- > 0) {
                        prev.btn.click();
                        await sleep(400);
                        prev = getSwitchBtn('上一题');
                    }
                }

                /**
                 * 单题「选完即校验」：选中后延迟复核当前题，不达标立刻修正，
                 * 确认与目标一致后才允许进入下一题。
                 */
                async function applyAndConfirmQuestion(num, ans, onProgress) {
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };

                    // 文本类题型（填空 / 问答）走写入输入框的流程，选择题走点选流程
                    const firstBox = getVisibleBox();
                    if (!firstBox) return {ok: false, actual: ''};
                    const firstTit = (firstBox.querySelector('.questionTit')?.textContent || '').trim();
                    if (isTextQuestion(detectTypeName(firstTit, firstBox))) {
                        return applyAndConfirmText(num, ans, onProgress);
                    }

                    const rounds = 3;
                    let lastActual = '';

                    for (let round = 1; round <= rounds; round++) {
                        const r = await applyAnswerToQuestion(num, ans, onProgress, 2);
                        if (r.actual) lastActual = r.actual;

                        // 延迟复核：排除页面状态回写延迟造成的偏差
                        await sleep(round === 1 ? 600 : 900);
                        const curNum = getCurrentNum();
                        if (curNum && curNum !== String(num)) {
                            progress(`↪️ 页面已切换到第 ${curNum} 题，第 ${num} 题视为完成`, 'info');
                            return {ok: true, actual: lastActual};
                        }
                        const box = getVisibleBox();
                        if (!box) break;
                        const options = readOptionEls(box);
                        const targetLetters = matchOptions(options, ans).map(t => t.letter).join('');
                        const actual = selectedLetters(options);
                        if (actual) lastActual = actual;

                        if (!targetLetters) {
                            progress(`⚠️ 第 ${num} 题答案「${ans}」未能匹配到选项，停止校验`, 'warn');
                            return {ok: false, actual: lastActual};
                        }
                        if (isSameSelection(actual, targetLetters)) {
                            if (round > 1 || !r.ok) progress(`✅ 第 ${num} 题复核通过：${actual}`, 'success');
                            return {ok: true, actual};
                        }
                        progress(`⚠️ 第 ${num} 题第 ${round}/${rounds} 轮复核不达标（当前 ${actual || '空'}，期望 ${targetLetters}），自动修正…`, 'warn');
                    }
                    return {ok: false, actual: lastActual};
                }

                /**
                 * 从当前题开始逐题作答：每题选完立即校验修正，通过后再进入下一题。
                 * 返回逐题结果用于完成后汇总（不再倒回第一题做全卷遍历检测）。
                 * onlyNums 为 null 时处理所有有答案的题；为数组时只处理指定题号。
                 */
                async function answerWalk(answers, onlyNums, onProgress) {
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    const results = [];
                    progress('🚀 开始逐题作答…', 'info');
                    let guard = 500;
                    while (guard-- > 0) {
                        const num = getCurrentNum();
                        if (!num) {
                            progress('⚠️ 未能识别当前题目编号，流程中断', 'warn');
                            break;
                        }

                        const ans = answers[num];
                        const ansEmpty = ans == null || (Array.isArray(ans) ? !ans.length : String(ans).trim() === '');
                        if (ansEmpty) {
                            if (!onlyNums) progress(`⚠️ 第 ${num} 题无答案，跳过`, 'warn');
                        } else if (!onlyNums || onlyNums.indexOf(num) !== -1) {
                            progress(`👉 第 ${num} 题：作答 ${briefAnswer(ans)}`, 'info');
                            const r = await applyAndConfirmQuestion(num, ans, onProgress);
                            results.push({
                                题号: num,
                                期望: Array.isArray(ans) ? ans.join(' / ') : String(ans),
                                状态: r.ok ? '✅ 正确' : `❌ 错误 (当前${briefAnswer(r.actual) || '空'})`,
                                选项内容: ''
                            });
                        }

                        const next = getSwitchBtn('下一题');

                        if (next.btn && next.canClick) {
                            next.btn.click();
                            await sleep(800);
                        } else {
                            break;
                        }
                    }
                    return results;
                }

                async function autoAnswerAndSave(answers, onProgress) {
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };

                    if (!getVisibleBox()) {
                        return {ok: false, msg: '未找到题目（.questionBox），请确认答题页已加载'};
                    }

                    await rewindToFirst(onProgress);
                    const results = await answerWalk(answers, null, onProgress);
                    await clickSaveIfExists(onProgress);

                    // 逐题校验已在作答时完成，这里只汇总，不再倒回第一题遍历检测（需要时可点「🔍 检测」）
                    const total = results.length;
                    const successCount = results.filter(r => r.状态.indexOf('✅') === 0).length;
                    progress(`🔍 逐题复核完成：✅ ${successCount} / ${total}`, total && successCount === total ? 'success' : 'warn');
                    logFailedResults(results, progress);
                    return {ok: true, results, successCount, total, allGood: total > 0 && successCount === total};
                }

                // 保存（页面有【保存】按钮则点击；不点【提交】，提交由用户手动完成）
                async function clickSaveIfExists(onProgress) {
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    const btns = Array.from(document.querySelectorAll('button, .Topicswitchingbtn, [class*="btn"]'));
                    const saveBtn = btns.find(b => {
                        const t = (b.textContent || '').trim();
                        return t.includes('保存') && !t.includes('提交');
                    });
                    if (saveBtn) {
                        saveBtn.click();
                        progress('已点击【保存】，等待写入…', 'info');
                        await sleep(1200);
                        return true;
                    }
                    progress('未找到【保存】按钮（如有请手动保存）', 'info');
                    return false;
                }

                /**
                 * 抓取题目：倒回第一题后逐题遍历读取（只读，不修改任何选择），
                 * 结果存入内存并渲染到面板，不再导出 JSON 文件。
                 */
                async function catchQuestionsFlow(onProgress) {
                    const progress = (msg, type) => {
                        try {
                            onProgress && onProgress(msg, type);
                        } catch (e) {
                        }
                    };
                    catching = true;
                    caughtQuestions = [];
                    let lastHash = '';
                    let guard = 500;

                    await rewindToFirst(onProgress);
                    progress('开始抓取题目…', 'info');

                    while (catching && guard-- > 0) {
                        const q = readQuestionForCatch();
                        if (q) {
                            const hash = q.num + '|' + q.stem.slice(0, 60);
                            if (hash !== lastHash) {
                                lastHash = hash;
                                caughtQuestions.push(q);
                                progress(`已抓取 ${caughtQuestions.length} 题…`, 'info');
                            }
                        }
                        const next = getSwitchBtn('下一题');
                        if (!next.btn || !next.canClick) break;
                        next.btn.click();
                        await sleep(900);
                    }

                    catching = false;
                    return caughtQuestions;
                }

                /* ================== 9. 面板（单面板 + 标签切换） ================== */
                let panel = null, bodyEl = null;
                let statusMsg = null, answerTa = null, titleEl = null;
                let tabAiBtn = null, tabManualBtn = null;
                let mainAiBtn = null, mainPasteBtn = null, checkBtn = null, catchBtn = null;
                let mode = 'ai';
                let compact = true, compactBtn = null;   // 默认以精简模式启动
                // 精简面板的进度元素：状态胶囊 / 百分比 / 进度条 / 完成数
                let compactStatusEl = null, compactFillEl = null, compactCardEl = null;
                let compactPctNumEl = null, compactChipEl = null;
                let compactCountEl = null, compactRestEl = null;
                let lastStatus = {msg: '待开始', type: ''};
                // 完成进度模型：total 在开始答题时写入，done 由状态文案推算
                const compactProgress = {done: 0, total: 0, pct: 0, kind: 'idle'};
                let compactPctRaf = 0;

                // 精简模式下，把每条日志变成页面上的消息气泡（不再显示面板日志区）
                Logger.setAddListener(function (item) {
                    if (compact) notify(item.type, item.msg);
                });
                let running = false, checking = false;
                let lastAiAnswers = null;

                function setStatus(msg, type) {
                    Logger.add(type || 'info', msg);
                    lastStatus = {msg: msg, type: type || ''};
                    updateCompactProgress(msg, type);
                    if (!statusMsg) return;
                    statusMsg.textContent = msg;
                    statusMsg.className = 'zai-status' + (type ? ' zai-status-' + type : '');
                }

                // 精简面板里的「完成进度」：状态胶囊 + 百分比 + 进度条 + 已完成题数
                function setCompactTotal(n) {
                    const total = Number(n) || 0;
                    if (total > 0) compactProgress.total = total;
                    renderCompactProgress(false);
                }

                function resetCompactProgress() {
                    compactProgress.done = 0;
                    compactProgress.total = 0;
                    compactProgress.pct = 0;
                    compactProgress.kind = 'idle';
                    renderCompactProgress(false);
                }

                // 百分比数字做一次补间，避免数字生硬跳变
                function tweenCompactPct(to, animate) {
                    if (!compactPctNumEl) return;
                    const target = Math.max(0, Math.min(100, Math.round(to)));
                    const from = Number(compactPctNumEl.textContent) || 0;
                    if (compactPctRaf) cancelAnimationFrame(compactPctRaf);
                    compactPctRaf = 0;
                    if (!animate || from === target || prefersReducedMotion()) {
                        compactPctNumEl.textContent = String(target);
                        return;
                    }
                    const started = (window.performance || Date).now();
                    const step = function (now) {
                        const p = Math.min(1, (now - started) / 320);
                        const eased = 1 - Math.pow(1 - p, 3);
                        compactPctNumEl.textContent = String(Math.round(from + (target - from) * eased));
                        if (p < 1) compactPctRaf = requestAnimationFrame(step);
                        else compactPctRaf = 0;
                    };
                    compactPctRaf = requestAnimationFrame(step);
                }

                function renderCompactProgress(animatePct) {
                    const st = compactProgress;
                    if (compactFillEl) {
                        if (st.kind === 'ok') {
                            compactFillEl.className = 'zai-cprogress-fill zai-cprogress-fill--ok';
                            compactFillEl.style.width = '100%';
                        } else if (st.kind === 'err') {
                            compactFillEl.className = 'zai-cprogress-fill zai-cprogress-fill--err';
                            compactFillEl.style.width = Math.max(st.pct, 6) + '%';
                        } else if (st.kind === 'run' && !st.total) {
                            compactFillEl.className = 'zai-cprogress-fill zai-cprogress-fill--indet';
                            compactFillEl.style.width = '40%';
                        } else {
                            compactFillEl.className = 'zai-cprogress-fill' + (st.kind === 'run' ? ' zai-cprogress-fill--run' : '');
                            compactFillEl.style.width = (st.pct > 0 ? Math.max(st.pct, 4) : 0) + '%';
                        }
                    }
                    if (compactChipEl) {
                        const labels = {idle: '待开始', run: '进行中', ok: '已完成', err: '出错'};
                        compactChipEl.textContent = labels[st.kind] || '待开始';
                        compactChipEl.className = 'zai-cp-chip' + (st.kind === 'idle' ? '' : ' zai-cp-chip--' + st.kind);
                    }
                    if (compactPctNumEl) {
                        const known = st.total > 0 || st.kind === 'ok' || st.kind === 'err';
                        if (known) {
                            compactPctNumEl.classList.remove('zai-cp-pct-num--dim');
                            tweenCompactPct(st.kind === 'ok' ? 100 : st.pct, animatePct);
                        } else {
                            compactPctNumEl.textContent = '··';
                            compactPctNumEl.classList.add('zai-cp-pct-num--dim');
                        }
                    }
                    if (compactCountEl) {
                        compactCountEl.textContent = st.total > 0
                            ? '已完成 ' + st.done + ' / ' + st.total + ' 题'
                            : (st.kind === 'run' ? '正在处理…' : '尚未开始');
                    }
                    if (compactRestEl) {
                        compactRestEl.textContent = st.total > 0
                            ? (st.done >= st.total ? '全部完成' : '剩余 ' + (st.total - st.done) + ' 题')
                            : '';
                    }
                }

                // 从状态文案推算完成进度：既认 “3 / 10” 这种完成数，也认 “第 3 题” 这种当前题号
                function updateCompactProgress(msg, type) {
                    if (!compactStatusEl) return;
                    const text = stripEmoji(msg);
                    compactStatusEl.textContent = text || '等待开始';
                    compactStatusEl.className = 'zai-cp-label' + (type ? ' zai-cp-' + type : '');

                    const st = compactProgress;
                    const cnt = /(\d+)\s*\/\s*(\d+)/.exec(text);
                    if (cnt && Number(cnt[2]) > 0 && /(完成|核对|校验|检测|作答|通过)/.test(text)) {
                        st.total = Number(cnt[2]);
                        st.done = Math.max(st.done, Math.min(Number(cnt[1]), st.total));
                    }
                    const qm = /第\s*(\d+)\s*题/.exec(text);
                    if (qm && st.total > 0) {
                        const n = Number(qm[1]);
                        const settled = /(通过|正确|已保存|完成)/.test(text);
                        st.done = Math.max(st.done, Math.min(st.total, settled ? n : n - 1));
                    }

                    const busy = running || checking || (typeof catching !== 'undefined' && catching);
                    const isFinal = /(逐题复核完成|逐题校验完成|检测完成|全部完成|已保存|答题完成)/.test(text);
                    if (type === 'error') st.kind = 'err';
                    else if ((st.total > 0 && st.done >= st.total) || (type === 'success' && isFinal)) st.kind = 'ok';
                    else if (busy || st.done > 0) st.kind = 'run';
                    else st.kind = 'idle';

                    st.pct = st.total > 0 ? Math.round(st.done / st.total * 100) : 0;
                    if (st.kind === 'ok') st.pct = 100;
                    renderCompactProgress(true);

                    // 出错时轻微抖动一次，提示异常
                    if (st.kind === 'err' && compactCardEl) {
                        const card = compactCardEl;
                        card.classList.remove('zai-cp-shake');
                        void card.offsetWidth;
                        card.classList.add('zai-cp-shake');
                        setTimeout(function () {
                            card.classList.remove('zai-cp-shake');
                        }, 480);
                    }
                }

                // 新一轮开始前清掉上一轮留在底部的答案与状态，避免误看成这次的结果
                function resetFooter() {
                    if (answerTa) answerTa.value = '';
                    if (statusMsg) {
                        statusMsg.textContent = '';
                        statusMsg.className = 'zai-status';
                    }
                    resetCompactProgress();
                }

                function setButtonsBusy(busy) {
                    [mainAiBtn, mainPasteBtn, checkBtn, catchBtn, tabAiBtn, tabManualBtn].forEach(btn => {
                        if (btn) btn.disabled = busy;
                    });
                    if (mainAiBtn) mainAiBtn.textContent = busy ? '执行中…' : '一键答题';
                    if (mainPasteBtn) mainPasteBtn.textContent = busy ? '执行中…' : '粘贴答题';
                    if (checkBtn) checkBtn.textContent = busy ? '执行中…' : '检测';
                }

                function updateTitle() {
                    if (!titleEl) return;
                    titleEl.textContent = '翻转课作业助手' + (caughtQuestions.length ? ' · ' + caughtQuestions.length + ' 题' : '');
                }

                // 按当前标签显示/隐藏对应元素，避免堆叠多余控件
                function updateModeUI() {
                    const isAi = mode === 'ai';
                    if (tabAiBtn) {
                        tabAiBtn.className = 'zai-tab' + (isAi ? ' zai-tab-active' : '');
                        tabAiBtn.setAttribute('aria-selected', isAi ? 'true' : 'false');
                    }
                    if (tabManualBtn) {
                        tabManualBtn.className = 'zai-tab' + (isAi ? '' : ' zai-tab-active');
                        tabManualBtn.setAttribute('aria-selected', isAi ? 'false' : 'true');
                    }
                    if (mainAiBtn) mainAiBtn.style.display = isAi ? '' : 'none';
                    if (mainPasteBtn) mainPasteBtn.style.display = isAi ? 'none' : '';
                    if (catchBtn) catchBtn.style.display = isAi ? 'none' : '';
                    // 答案框两种模式都可见：AI 模式展示传回的答案（只读），手动模式可编辑
                    if (answerTa) {
                        answerTa.readOnly = isAi;
                        answerTa.placeholder = isAi
                            ? 'AI 传回的答案（切到「手动填入」可编辑）'
                            : '粘贴 AI 返回的答案 JSON，例如：{"1":"B","3":["8080","9000"],"4":"问答答案文本"}';
                    }
                }

                function switchMode(next) {
                    if (next === mode) return;
                    if (running || checking) {
                        setStatus('执行中，暂不能切换标签', 'warn');
                        return;
                    }
                    mode = next;
                    updateModeUI();
                    renderView();
                    setStatus(next === 'ai'
                        ? 'AI 模式：点「一键答题」自动抓题、获取答案并作答保存'
                        : '手动模式：粘贴答案 JSON 后点「▶ 粘贴答题」', 'info');
                }

                // 精简模式：只保留 AI 自动与「一键答题」，日志改为消息形式内嵌显示
                function toggleCompact() {
                    if (running || checking) {
                        setStatus('执行中，暂不能切换显示模式', 'warn');
                        return;
                    }
                    compact = !compact;
                    if (compact) mode = 'ai';
                    if (panel) panel.classList.toggle('zai-compact', compact);
                    if (compactBtn) {
                        compactBtn.textContent = compact ? '完整模式' : '精简模式';
                        compactBtn.title = compact ? '返回完整面板' : '切换到精简模式（仅保留开始答题）';
                    }
                    updateModeUI();
                    renderView();
                }

                function createPanel() {
                    if (panel) return;
                    injectStyle();

                    panel = h('div', 'zai-panel');
                    if (compact) {
                        mode = 'ai';                        // 精简模式固定 AI 自动
                        panel.classList.add('zai-compact');
                    }

                    const header = h('div', 'zai-header');
                    titleEl = h('span', 'zai-title', '作业助手');
                    const hbtns = h('span', 'zai-hbtns');
                    const noticeBtn = h('button', 'zai-icon-btn zai-icon-btn--wide', '使用前须知');
                    noticeBtn.type = 'button';
                    noticeBtn.title = '查看使用前须知';
                    compactBtn = h('button', 'zai-icon-btn zai-icon-btn--wide', compact ? '完整模式' : '精简模式');
                    compactBtn.type = 'button';
                    compactBtn.title = compact ? '返回完整面板' : '切换到精简模式（仅保留开始答题）';
                    hbtns.appendChild(noticeBtn);
                    hbtns.appendChild(compactBtn);
                    header.appendChild(titleEl);
                    header.appendChild(hbtns);

                    // 标签栏：AI 自动 / 手动填入
                    const tabbar = h('div', 'zai-tabbar');
                    tabAiBtn = h('button', 'zai-tab', 'AI 自动');
                    tabAiBtn.title = '全自动：后台 DeepSeek 获取答案并作答';
                    tabAiBtn.setAttribute('role', 'tab');
                    tabManualBtn = h('button', 'zai-tab', '手动填入');
                    tabManualBtn.title = '手动粘贴答案 JSON 后作答';
                    tabManualBtn.setAttribute('role', 'tab');
                    tabbar.appendChild(tabAiBtn);
                    tabbar.appendChild(tabManualBtn);

                    // 工具栏：按标签显隐，避免多余控件
                    const toolbar = h('div', 'zai-toolbar');
                    catchBtn = h('button', 'zai-btn', '抓取题目');
                    catchBtn.title = '遍历答题页抓取全部题目（只读，不会改动任何选择）';
                    mainAiBtn = h('button', 'zai-btn zai-btn-primary zai-btn-main', '一键答题');
                    mainAiBtn.title = '全自动：抓取题目 → 发送后台 DeepSeek → 自动作答保存并核对';
                    mainPasteBtn = h('button', 'zai-btn zai-btn-primary', '粘贴答题');
                    mainPasteBtn.title = '按下方答案 JSON 自动作答并保存';
                    checkBtn = h('button', 'zai-btn', '检测');
                    checkBtn.title = '检测当前页面作答是否符合答案';
                    toolbar.appendChild(catchBtn);
                    toolbar.appendChild(mainAiBtn);
                    toolbar.appendChild(mainPasteBtn);
                    toolbar.appendChild(checkBtn);

                    bodyEl = h('div', 'zai-body');
                    bodyEl.appendChild(h('div', 'zai-waiting', '尚未抓取题目，点「抓取题目」自动遍历答题页'));

                    const footerEl = h('div', 'zai-footer');
                    answerTa = document.createElement('textarea');
                    answerTa.className = 'zai-textarea';
                    answerTa.placeholder = '粘贴 AI 返回的答案 JSON，例如：{"1":"B","3":["8080","9000"],"4":"问答答案文本"}';
                    const actionRow = h('div', 'zai-action-row');
                    statusMsg = h('span', 'zai-status', '');
                    actionRow.appendChild(statusMsg);
                    footerEl.appendChild(answerTa);
                    footerEl.appendChild(actionRow);

                    // 精简模式的内容区：状态胶囊 + 百分比 + 进度条 + 已完成题数
                    const cprogress = h('div', 'zai-cprogress');
                    compactCardEl = cprogress;
                    const cpTop = h('div', 'zai-cp-top');
                    compactChipEl = h('span', 'zai-cp-chip', '待开始');
                    const cpPct = h('span', 'zai-cp-pct');
                    compactPctNumEl = h('span', 'zai-cp-pct-num zai-cp-pct-num--dim', '··');
                    cpPct.appendChild(compactPctNumEl);
                    cpPct.appendChild(h('span', 'zai-cp-pct-unit', '%'));
                    cpTop.appendChild(compactChipEl);
                    cpTop.appendChild(cpPct);
                    const cpTrack = h('div', 'zai-cprogress-track');
                    compactFillEl = h('div', 'zai-cprogress-fill');
                    cpTrack.appendChild(compactFillEl);
                    compactStatusEl = h('div', 'zai-cp-label', '等待开始');
                    const cpFoot = h('div', 'zai-cp-foot');
                    compactCountEl = h('span', 'zai-cp-count', '尚未开始');
                    compactRestEl = h('span', 'zai-cp-rest', '');
                    cpFoot.appendChild(compactCountEl);
                    cpFoot.appendChild(compactRestEl);
                    cprogress.appendChild(cpTop);
                    cprogress.appendChild(cpTrack);
                    cprogress.appendChild(compactStatusEl);
                    cprogress.appendChild(cpFoot);

                    panel.appendChild(header);
                    panel.appendChild(tabbar);
                    panel.appendChild(toolbar);
                    panel.appendChild(cprogress);
                    panel.appendChild(bodyEl);
                    panel.appendChild(footerEl);
                    const logEl = Logger.createSection();
                    panel.appendChild(logEl);
                    (document.body || document.documentElement).appendChild(panel);
                    if (compact) updateCompactProgress(lastStatus.msg, lastStatus.type);

                    noticeBtn.addEventListener('click', e => {
                        e.stopPropagation();
                        openNotice();
                    });
                    compactBtn.addEventListener('click', e => {
                        e.stopPropagation();
                        toggleCompact();
                    });
                    tabAiBtn.addEventListener('click', () => switchMode('ai'));
                    tabManualBtn.addEventListener('click', () => switchMode('manual'));
                    mainAiBtn.addEventListener('click', onAiAutoAnswer);
                    mainPasteBtn.addEventListener('click', onPasteAnswer);
                    catchBtn.addEventListener('click', onCatchOrCopy);
                    checkBtn.addEventListener('click', onManualCheck);

                    updateModeUI();
                    updateCatchBtnUI();
                    makeDraggable(panel, header);
                }

                /* ================== 10. AI 自动答题（AI 界面主流程） ================== */
                async function onAiAutoAnswer() {
                    if (running || catching) return;
                    // 清空上一轮留在底部的答案与状态
                    resetFooter();
                    if (!getVisibleBox()) {
                        setStatus('未找到题目（.questionBox），请确认答题页已加载', 'warn');
                        return;
                    }

                    running = true;
                    setButtonsBusy(true);

                    // 1. 抓取全部题目（倒回第一题逐题遍历，只读，不改动任何选择）
                    setStatus('📥 正在抓取题目…', 'info');
                    let qs = [];
                    try {
                        qs = await catchQuestionsFlow((msg, type) => setStatus(msg, type));
                    } catch (e) {
                        setStatus('抓取失败：' + ((e && e.message) || e), 'error');
                        running = false;
                        setButtonsBusy(false);
                        return;
                    }
                    renderView();
                    if (!qs.length) {
                        setStatus('未抓取到题目，请确认在作业答题页', 'error');
                        running = false;
                        setButtonsBusy(false);
                        return;
                    }

                    const text = buildAIText();
                    if (!text) {
                        setStatus('题目文本构建失败', 'error');
                        running = false;
                        setButtonsBusy(false);
                        return;
                    }
                    setCompactTotal(qs.length);
                    setStatus(`✅ 已抓取 ${qs.length} 题，正在联系后台 DeepSeek…`, 'success');

                    let res = null;
                    for (let attempt = 1; attempt <= 2; attempt++) {
                        try {
                            res = await ds.askDeepSeek(text, {
                                timeoutMs: CONFIG.aiTimeoutMs,
                                expectedCount: qs.length,
                                onProgress: function (msg) {
                                    setStatus(msg, 'info');
                                }
                            });
                        } catch (e) {
                            res = {error: '请求失败：' + ((e && e.message) || e)};
                        }
                        if (res && res.answers) break;
                        if (attempt === 1) {
                            setStatus('⚠️ ' + ((res && res.error) || 'AI 未返回有效结果') + '，正在自动重试一次…', 'warn');
                            await new Promise(r => setTimeout(r, 1500));
                        }
                    }

                    if (!res || !res.answers) {
                        setStatus((res && res.error) || 'AI 作答失败', 'error');
                        running = false;
                        setButtonsBusy(false);
                        return;
                    }

                    const answers = res.answers;
                    lastAiAnswers = answers;
                    if (answerTa) answerTa.value = JSON.stringify(answers);
                    console.log('🤖 AI 返回答案:', answers);
                    setStatus('✅ AI 已返回 ' + Object.keys(answers).length + ' 个答案，开始自动作答…', 'success');

                    try {
                        const r = await autoAnswerAndSave(answers, (msg, type) => setStatus(msg, type));
                        if (!r.ok) {
                            setStatus(r.msg, 'error');
                            return;
                        }
                        console.table(r.results);
                        setStatus(
                            `逐题校验完成：✅ ${r.successCount} / ${r.total}` + (r.allGood ? '，请手动点提交作业' : '，不达标题见 console.table 或点「🔍 检测」复查'),
                            r.allGood ? 'success' : 'error'
                        );
                        console.log(
                            `%c${r.allGood ? '🎉 全部正确并保存成功' : '⚠️ 存在异常'} ｜ 正确 ${r.successCount} / 共 ${r.total}`,
                            `font-weight:bold;font-size:13px;color:${r.allGood ? '#389e0d' : '#d4380d'}`
                        );
                        if (r.allGood) {
                            console.log('%c👉 接下来请手动点击页面右上角的【提交作业】按钮完成作业！', 'color:#fa8c16;font-weight:bold;font-size:15px;');
                        } else {
                            console.log('%c👉 部分题目可能没保存成功，请检查上方表格中的错误项', 'color:#d4380d;font-weight:bold;');
                        }
                    } catch (e) {
                        setStatus('执行失败：' + ((e && e.message) || e), 'error');
                        console.error('[自动答题] 异常', e);
                    } finally {
                        running = false;
                        setButtonsBusy(false);
                        updateCatchBtnUI();
                    }
                }

                // 抓取按钮二态：未抓取时=抓取题目；抓取成功后=复制给 AI
                function updateCatchBtnUI() {
                    if (!catchBtn) return;
                    if (caughtQuestions.length) {
                        catchBtn.textContent = '复制给 AI';
                        catchBtn.title = '复制题目文本（含提示词），去其他 AI 获取答案';
                    } else {
                        catchBtn.textContent = '抓取题目';
                        catchBtn.title = '遍历答题页抓取全部题目（只读，不会改动任何选择）';
                    }
                }

                function copyAIText() {
                    const text = buildAIText();
                    if (!text) {
                        setStatus('尚未抓取到题目，请先抓取', 'warn');
                        updateCatchBtnUI();
                        return;
                    }
                    copyText(text);
                    setStatus('✅ 已复制题目文本（含提示词），去其他 AI 获取答案吧', 'success');
                    if (catchBtn) {
                        catchBtn.textContent = '已复制';
                        setTimeout(updateCatchBtnUI, 1200);
                    }
                }

                function onCatchOrCopy() {
                    if (running || catching) return;
                    if (caughtQuestions.length) copyAIText();
                    else onCatchQuestions();
                }

                /* ================== 10.5 抓取题目 ================== */
                async function onCatchQuestions() {
                    if (running || catching) return;
                    if (!getVisibleBox()) {
                        setStatus('未找到题目（.questionBox），请确认答题页已加载', 'warn');
                        return;
                    }
                    catching = true;
                    setButtonsBusy(true);
                    if (catchBtn) {
                        catchBtn.disabled = true;
                        catchBtn.textContent = '⏳ 抓取中…';
                    }
                    setStatus('📥 开始抓取题目…', 'info');

                    try {
                        const qs = await catchQuestionsFlow((msg, type) => setStatus(msg, type));
                        renderView();
                        if (qs.length) {
                            setStatus(`✅ 抓取完成，共 ${qs.length} 题`, 'success');
                        } else {
                            setStatus('⚠️ 未抓取到题目，请确认在作业答题页', 'warn');
                        }
                    } catch (e) {
                        setStatus('抓取失败：' + ((e && e.message) || e), 'error');
                        console.error('[抓取] 异常', e);
                    } finally {
                        catching = false;
                        setButtonsBusy(false);
                        updateCatchBtnUI();
                    }
                }

                /* ================== 11. 粘贴答案答题（手动界面流程） ================== */
                async function onPasteAnswer() {
                    if (running) return;
                    if (!answerTa) {
                        setStatus('手动界面未打开', 'warn');
                        return;
                    }
                    const raw = (answerTa.value || '').trim();
                    if (!raw) {
                        setStatus('请先粘贴 AI 返回的答案 JSON', 'warn');
                        answerTa.focus();
                        return;
                    }
                    const answers = extractAnswersFromText(raw);
                    if (!answers || !Object.keys(answers).length) {
                        setStatus('未能从文本中解析出有效答案（需为 {"题号":"字母"}）', 'error');
                        return;
                    }

                    const answerCount = Object.keys(answers).length;
                    lastAiAnswers = answers;
                    console.log('🔍 已解析答案:', answers);

                    running = true;
                    setButtonsBusy(true);
                    setStatus(`开始执行（${answerCount} 个答案），请勿关闭页面…`, 'info');

                    try {
                        const r = await autoAnswerAndSave(answers, (msg, type) => setStatus(msg, type));
                        if (!r.ok) {
                            setStatus(r.msg, 'error');
                            return;
                        }
                        console.table(r.results);
                        setStatus(
                            `逐题校验完成：✅ ${r.successCount} / ${r.total}` + (r.allGood ? '，请手动点提交作业' : '，不达标题见 console.table 或点「🔍 检测」复查'),
                            r.allGood ? 'success' : 'error'
                        );
                        if (r.allGood) {
                            console.log('%c👉 接下来请手动点击页面右上角的【提交作业】按钮完成作业！', 'color:#fa8c16;font-weight:bold;font-size:15px;');
                        }
                    } catch (e) {
                        setStatus('执行失败：' + ((e && e.message) || e), 'error');
                        console.error('[自动答题] 异常', e);
                    } finally {
                        running = false;
                        setButtonsBusy(false);
                    }
                }

                /* ================== 12. 手动检测 ================== */
                function renderCheckReport(v) {
                    if (!bodyEl) return;
                    const old = document.getElementById('zai-check-report');
                    if (old) old.remove();
                    const box = h('div', 'zai-report');
                    box.id = 'zai-check-report';
                    box.appendChild(h('div', 'zai-report-title',
                        '🔍 检测报告：✅ ' + v.successCount + ' / ' + v.total + (v.successCount === v.total ? '（全部达标）' : '（存在不达标）')));
                    v.results.forEach(r => {
                        const row = h('div', 'zai-report-row');
                        row.appendChild(h('span', 'zai-report-num', '第 ' + r.题号 + ' 题'));
                        const ok = r.状态.indexOf('✅') === 0;
                        const noAnswer = r.状态.indexOf('❌ 未作答') === 0;
                        const cls = ok ? 'zai-report-ok' : (noAnswer ? 'zai-report-warn' : 'zai-report-bad');
                        row.appendChild(h('span', cls, '期望 ' + r.期望 + ' → ' + r.状态 + (r.选项内容 ? '（' + r.选项内容 + '）' : '')));
                        box.appendChild(row);
                    });
                    bodyEl.insertBefore(box, bodyEl.firstChild);
                }

                async function onManualCheck() {
                    if (running) {
                        setStatus('自动答题执行中，请等待结束后再检测', 'warn');
                        return;
                    }
                    if (checking) return;

                    // 答案来源：优先文本框粘贴的内容，其次最近一次 AI 返回的答案
                    let answers = null;
                    const raw = (answerTa && answerTa.value || '').trim();
                    if (raw) {
                        const parsed = extractAnswersFromText(raw);
                        if (parsed && Object.keys(parsed).length) answers = parsed;
                    }
                    if (!answers && lastAiAnswers) answers = lastAiAnswers;

                    if (!answers || !Object.keys(answers).length) {
                        setStatus('请先让 AI 答题，或粘贴答案 JSON 后再检测', 'warn');
                        return;
                    }
                    if (!getVisibleBox()) {
                        setStatus('未找到题目（.questionBox），请确认在答题页', 'warn');
                        return;
                    }

                    checking = true;
                    setButtonsBusy(true);
                    if (checkBtn) checkBtn.textContent = '⏳ 检测中…';
                    setStatus('🔍 正在检测当前作答情况…', 'info');

                    try {
                        await new Promise(r => setTimeout(r, 200));
                        const v = await verifyWithRetry(answers, (msg, type) => setStatus(msg, type));
                        renderCheckReport(v);
                        console.table(v.results);
                        const allGood = v.successCount === v.total;
                        setStatus(
                            '检测完成：✅ ' + v.successCount + ' / ' + v.total + (allGood ? '，全部达标' : '，不达标的题可点「🚀 一键答题」或「▶ 粘贴答题」修正'),
                            allGood ? 'success' : 'warn'
                        );
                    } catch (e) {
                        setStatus('检测失败：' + ((e && e.message) || e), 'error');
                        console.error('[检测] 异常', e);
                    } finally {
                        checking = false;
                        setButtonsBusy(false);
                    }
                }

                /* ================== 12.5 渲染（来自 1.js） ================== */
                function renderView() {
                    if (!bodyEl) return;
                    bodyEl.innerHTML = '';
                    if (!caughtQuestions.length) {
                        bodyEl.appendChild(h('div', 'zai-waiting', '尚未抓取题目，点「抓取题目」自动遍历答题页'));
                        return;
                    }
                    updateTitle();
                    renderParsed();
                }

                function renderParsed() {
                    const sum = h('div', 'zai-summary');
                    sum.appendChild(h('div', 'zai-summary-title', '翻转课作业'));
                    sum.appendChild(h('div', 'zai-summary-meta', '共 ' + caughtQuestions.length + ' 题（来源：页面遍历抓取）'));
                    bodyEl.appendChild(sum);
                    caughtQuestions.forEach(q => bodyEl.appendChild(renderQuestionCard(q, '')));
                }

                function renderQuestionCard(q, prefix) {
                    const no = prefix ? `${prefix}-${q.index}` : String(q.index);
                    const card = h('div', 'zai-card');
                    const head = h('div', 'zai-card-head');
                    head.appendChild(h('span', 'zai-card-num', '第 ' + no + ' 题'));
                    const tags = h('span', 'zai-card-tags');
                    tags.appendChild(h('span', 'zai-tag', q.typeName));
                    if (q.blanks > 1) tags.appendChild(h('span', 'zai-tag', q.blanks + ' 空'));
                    if (q.score != null && q.score !== '') tags.appendChild(h('span', 'zai-score', q.score + ' 分'));
                    head.appendChild(tags);
                    card.appendChild(head);
                    card.appendChild(h('div', 'zai-stem', q.stem));
                    if (q.options.length) {
                        const box = h('div', 'zai-options');
                        q.options.forEach(o => {
                            const row = h('div', 'zai-option');
                            row.appendChild(h('span', 'zai-option-label', o.label + '.'));
                            row.appendChild(h('span', 'zai-option-content', o.content));
                            box.appendChild(row);
                        });
                        card.appendChild(box);
                    }
                    if (q.children.length) {
                        const sub = h('div', 'zai-sub');
                        q.children.forEach(c => sub.appendChild(renderQuestionCard(c, no)));
                        card.appendChild(sub);
                    }
                    return card;
                }

                /* ================== 13. 构建 AI 文本（来自 1.js） ================== */
                function appendQuestionLines(lines, q, prefix) {
                    const no = prefix ? `${prefix}-${q.index}` : String(q.index);
                    const scorePart = (q.score != null && q.score !== '') ? ` ${q.score}分` : '';
                    lines.push(`${no}. [${q.typeName}${scorePart}] ${q.stem}`);
                    if (q.blanks > 1) lines.push(`   （本题共 ${q.blanks} 个空，请按空位顺序用数组给出 ${q.blanks} 个答案）`);
                    q.options.forEach(o => lines.push(`   ${o.label}. ${o.content}`));
                    if (q.children.length) q.children.forEach(c => appendQuestionLines(lines, c, no));
                }

                function buildAIText() {
                    if (!caughtQuestions.length) return '';
                    const lines = [];
                    lines.push(AI_PROMPT);
                    lines.push('');
                    lines.push('========== 题目开始 ==========');
                    lines.push('作业名称：翻转课作业（共 ' + caughtQuestions.length + ' 题）');
                    const typeStat = {};
                    caughtQuestions.forEach(q => {
                        typeStat[q.typeName] = (typeStat[q.typeName] || 0) + 1;
                    });
                    lines.push('题型分布：' + Object.keys(typeStat).map(t => t + ' ' + typeStat[t] + ' 题').join('、'));
                    lines.push('');
                    caughtQuestions.forEach(q => {
                        appendQuestionLines(lines, q, '');
                        lines.push('');
                    });
                    lines.push('========== 题目结束 ==========');
                    lines.push('');
                    lines.push('请先仔细思考、反复打磨每一道题，然后只输出 {"题号": 答案} 形式的最终 JSON：单选题/多选题/判断题给选项字母，填空题给精确答案（严格按空位顺序，多个空用数组），问答题给结构化且专业具体的答案（按分值决定要点数量，写到机制与步骤层面）。填空与问答必须写到可判分的程度，不能留空；除这个 JSON 外不要输出任何说明。');
                    return lines.join('\n');
                }

                /* ================== 15. 路由判断与启动（来自 1.js + 菜单命令） ================== */
                function isTargetRoute() {
                    return location.pathname.indexOf('atHomeworkExam') !== -1;
                }

                ds.initRelayChannels();

                function syncPanelWithRoute() {
                    if (isTargetRoute()) {
                        if (!panel) createPanel();
                        else panel.style.display = '';
                        renderView();
                    } else {
                        if (panel) panel.style.display = 'none';
                    }
                }

                function bootSync() {
                    syncPanelWithRoute();
                    setTimeout(syncPanelWithRoute, 300);
                    setTimeout(syncPanelWithRoute, 1000);
                    setTimeout(syncPanelWithRoute, 2000);
                }

                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', bootSync);
                } else {
                    bootSync();
                }
                pageWindow.addEventListener('hashchange', syncPanelWithRoute);

                if (typeof GM_registerMenuCommand === 'function') {
                    GM_registerMenuCommand('启动后台 AI 助手（DeepSeek）', function () {
                        if (ds.isLocalWorkerOpen()) {
                            alert('后台助手已在运行（本页打开的），无需重复启动。');
                            return;
                        }
                        if (ds.isWorkerAlive()) {
                            alert('后台助手已在其他标签页运行，无需重复启动。');
                            return;
                        }
                        if (ds.openWorkerTab()) {
                            alert('后台助手已启动。\n\n' +
                                '· 新标签已在后台打开（不会切走你的当前页面）；\n' +
                                '· 请在该标签页登录 DeepSeek；\n' +
                                '· 它会在 3 分钟无任务后自动关闭。\n\n' +
                                '现在点击「🚀 一键答题」试试吧。');
                        } else {
                            alert('启动失败：浏览器拦截了弹窗。\n\n' +
                                '请在 Tampermonkey 管理面板 → 本脚本 → 设置里确认已授权「打开标签页」。');
                        }
                    });
                }

                log('答题页部分已加载');

            })();
        }
    } else {

        /* ============================================================
         *  D. DeepSeek 工作页（来自 2.js 的 worker 逻辑，同时服务两个站点）
         * ============================================================ */
        document.title = 'AI 答题助手';
        log('DeepSeek 工作标签页已加载');

        /* ---------- 让页面在隐藏标签页里也能继续渲染 ---------- */
        // 隐藏标签页里 requestAnimationFrame 会被暂停，DeepSeek 的流式输出是用 rAF 批量刷 DOM 的，
        // 于是文字会停在某个字数不动，只有切回标签页才继续长。
        // 这里把 rAF 换成 setTimeout 驱动：可见时保持原生行为，隐藏时用定时器继续渲染。
        // （必须在页面自己的脚本执行前安装，所以放在最前面）
        (function shimHiddenRaf() {
            const w = pageWindow;
            if (!w || typeof w.requestAnimationFrame !== 'function') return;
            const nativeRaf = w.requestAnimationFrame.bind(w);
            const nativeCaf = typeof w.cancelAnimationFrame === 'function' ? w.cancelAnimationFrame.bind(w) : null;
            const timers = new Map();
            let seq = 1;

            w.requestAnimationFrame = function (cb) {
                if (!document.hidden) return nativeRaf(cb);
                const id = seq++;
                timers.set(id, setTimeout(function () {
                    timers.delete(id);
                    try {
                        cb(w.performance ? w.performance.now() : Date.now());
                    } catch (e) {
                    }
                }, 16));
                return id;
            };
            w.cancelAnimationFrame = function (id) {
                if (timers.has(id)) {
                    clearTimeout(timers.get(id));
                    timers.delete(id);
                    return;
                }
                if (nativeCaf) nativeCaf(id);
            };
            log('已接管隐藏标签页下的 requestAnimationFrame');
        })();

        /* ---------- 自动保活：避免后台标签页被浏览器节流 / 冻结 ---------- */
        // Chrome 在标签页隐藏约 5 分钟后会节流定时器（最慢 1 次/分钟），之后可能直接冻结该页，
        // 冻结后所有 JS 停摆：既不抓取回答也不回传 done，面板只能空等超时（手动切回才恢复）。
        // 这里用两种手段让标签页保持活跃，全程无需用户切回：
        //  1) Web Locks：持有一把永不释放的锁，Chromium 的冻结 / 丢弃策略会跳过持锁页面；
        //  2) 静音音频：Chrome 不会冻结「正在播放音频」的标签页（自动播放受限时静默失败）。
        function startWorkerKeepAlive() {
            try {
                if (navigator.locks && typeof navigator.locks.request === 'function') {
                    navigator.locks.request('zai-deepseek-worker', {mode: 'exclusive'}, function () {
                        return new Promise(function () {
                        });   // 永不 resolve：锁一直被本页持有
                    }).catch(function () {
                    });
                    log('已持有 Web Lock，防止后台页被冻结');
                }
            } catch (e) {
            }

            let audioCtx = null;
            let audioOn = false;

            function startSilentAudio() {
                if (audioOn) return true;
                try {
                    const AC = window.AudioContext || window.webkitAudioContext;
                    if (!AC) return false;
                    if (!audioCtx) audioCtx = new AC();
                    if (audioCtx.state === 'suspended') {
                        audioCtx.resume().catch(function () {
                        });
                    }
                    if (audioCtx.state !== 'running') return false;
                    // 25Hz + 极低音量：人耳基本不可闻，但足以让标签页被判定为「有声」，从而免于节流/冻结
                    const osc = audioCtx.createOscillator();
                    const gain = audioCtx.createGain();
                    osc.frequency.value = 25;
                    gain.gain.value = 0.01;
                    osc.connect(gain);
                    gain.connect(audioCtx.destination);
                    osc.start();
                    audioOn = true;
                    log('已启用静音音频保活');
                    return true;
                } catch (e) {
                    return false;
                }
            }

            startSilentAudio();
            // 自动播放策略可能让 AudioContext 停在 suspended：页面出现用户操作后再试一次
            ['pointerdown', 'keydown', 'click'].forEach(function (t) {
                document.addEventListener(t, startSilentAudio, true);
            });
            // 兜底：定时确认音频仍在播放（被系统挂起时重新 resume）
            setInterval(function () {
                startSilentAudio();
                if (!audioOn && audioCtx) {
                    try {
                        audioCtx.resume().catch(function () {
                        });
                    } catch (e) {
                    }
                }
            }, 20000);
        }

        // 懒启动：只有真正接过任务的工作页才保活，普通 DeepSeek 聊天页不受影响
        let keepAliveStarted = false;

        function ensureKeepAlive() {
            if (keepAliveStarted) return;
            keepAliveStarted = true;
            startWorkerKeepAlive();
        }

        /* ---------- 直读流式响应（不依赖页面渲染） ---------- */
        // 隐藏标签页里 requestAnimationFrame 会被暂停，DeepSeek 的流式渲染依赖它，
        // 所以 DOM 上的文字会停在某个字数不动，只有切回标签页才继续长。
        // 这里直接拦截 fetch 的响应流，自己累积 token，后台也能实时拿到完整回答。
        let sseText = '';          // 已累积的回答正文（不含思考过程）
        let sseThinking = '';      // 思考过程（仅用于日志）
        let sseUsable = false;     // 是否已经收到直读文本（用于一次性日志）
        let sseFinished = false;
        let sseHooked = false;
        let sseTaskSeq = 0;        // 当前这条流属于哪个任务，防止旧流串到新任务
        let sseLastPath = '';      // 上一帧的路径（有些帧会省略 p）
        let sseSampleLogged = false;

        function resetSse() {
            sseText = '';
            sseThinking = '';
            sseUsable = false;
            sseFinished = false;
            sseLastPath = '';
            sseSampleLogged = false;
            sseTaskSeq = currentTaskSeq;
        }

        // 当前任务对应的直读文本（任务切换后旧流不再采信）
        function currentSseText() {
            return (sseTaskSeq === currentTaskSeq && sseText) ? sseText : '';
        }

        // 文本中是否已出现「完整且可解析」的答案（容错解析，能处理未转义引号 / 裸换行）
        // 必须出现配对的大括号，否则只是流式输出到一半的片段，不能判定完成
        function looksLikeAnswerJson(text) {
            if (!text) return false;
            const start = text.indexOf('{');
            if (start === -1) return false;
            if (matchBracket(text, start) === -1) return false;
            const obj = pickAnswersObject(text);
            return !!(obj && Object.keys(obj).length);
        }

        /**
         * 两路取优：DOM 文本与直读文本各自可能残缺（DOM 在后台可能不刷新，
         * 直读可能因协议变化只拿到一部分），谁的答案更完整就用谁，
         * 避免单路截断导致整轮「已回传但解析不到答案」。
         */
        function chooseText() {
            const sse = currentSseText();
            const dom = domText || '';
            if (dom && looksLikeAnswerJson(dom)) return {text: dom, from: 'dom'};
            if (sse && looksLikeAnswerJson(sse)) return {text: sse, from: 'sse'};
            if (dom.length >= sse.length) return {text: dom, from: 'dom'};
            return {text: sse, from: 'sse'};
        }

        function publishSse() {
            if (!currentSseText()) return;
            flushRelay(false);
        }

        // 统一出口：选优 → 有变化就回传（不依赖后台定时器，谁更新谁触发）
        function flushRelay(force) {
            if (!busy) return;
            const picked = chooseText();
            if (!picked.text) return;
            if (!force && Date.now() - lastRelayAt < 120) return;
            lastRelayAt = Date.now();
            if (picked.text === lastText) return;
            lastText = picked.text;
            lastChangeTime = Date.now();
            doneSent = false;
            relayMessage({text: lastText, done: false});
        }

        function finishRelay() {
            if (!busy) return;
            const picked = chooseText();
            if (!picked.text) {
                return;
            }
            if (doneSent) return;
            doneSent = true;
            lastText = picked.text;
            lastChangeTime = Date.now();
            relayMessage({text: lastText, done: true});
            markClaimed(currentTaskSeq, currentSite);
            log('回答回传完毕（来源：' + (picked.from === 'sse' ? '流式直读' : '页面文本') +
                '，共 ' + picked.text.length + ' 字）');
            finishTask();
        }

        // 流结束：只有已经能解析出答案才立刻收尾；否则交给统一判定继续等
        // （直读可能被截断，DOM 通道也许还能拿到完整文本）
        function onSseEnd() {
            if (!busy) return;
            const picked = chooseText();
            if (!picked.text) return;
            flushRelay(true);
            if (looksLikeAnswerJson(picked.text)) finishRelay();
        }

        function appendSseContent(txt, replace) {
            if (!txt) return;
            const first = !sseUsable;
            sseUsable = true;
            if (replace) sseText = txt;
            else sseText += txt;
            if (first && sseTaskSeq === currentTaskSeq) log('已识别流式响应，启用直读通道');
            publishSse();
        }

        function appendSseThink(txt) {
            if (txt) sseThinking += txt;
        }

        /**
         * 兼容 DeepSeek 的几种帧形态（不同版本/接口都出现过）：
         *   1. {"p":"response/content","o":"APPEND","v":"片段"}   —— 片段协议
         *   2. {"p":"response/fragments","v":[{"type":"RESPONSE","content":"片段"}]}
         *   3. {"v":{"response":{"content":"...","status":"FINISHED"}}} —— 整包消息
         *   4. {"p":"response/status","v":"FINISHED"}             —— 结束标记
         */
        function consumeSseNode(obj, depth) {
            if (!obj || typeof obj !== 'object') return;
            if ((depth || 0) > 6) return;

            const rawPath = typeof obj.p === 'string' ? obj.p : (typeof obj.path === 'string' ? obj.path : '');
            if (rawPath) sseLastPath = rawPath;
            const path = rawPath || sseLastPath;
            const op = String(obj.o || obj.op || '').toUpperCase();
            const v = obj.v !== undefined ? obj.v : obj.value;

            if (typeof obj.status === 'string' && /FINISH|DONE|COMPLETE/i.test(obj.status)) sseFinished = true;
            if (obj.finished === true) sseFinished = true;

            // 片段对象：{type:'RESPONSE'|'THINK', content:'...'}
            if (typeof obj.content === 'string' && obj.content) {
                if (/think|reason/i.test(String(obj.type || '')) || /thinking/i.test(path)) appendSseThink(obj.content);
                else appendSseContent(obj.content, false);
            }
            if (typeof obj.thinking_content === 'string' && obj.thinking_content) appendSseThink(obj.thinking_content);

            if (v === undefined) return;

            if (typeof v === 'string') {
                if (/thinking|reason/i.test(path)) {
                    appendSseThink(v);
                    return;
                }
                if (/status|finish|end/i.test(path)) {
                    if (/FINISH|DONE|END|COMPLETE/i.test(v)) sseFinished = true;
                    return;
                }
                if (!path) {
                    // 没路径的裸片段：只有已经开始收到正文时才认为是续写
                    if (sseText) appendSseContent(v, false);
                    return;
                }
                if (!/content|response/i.test(path)) return;
                appendSseContent(v, op === 'SET');
                return;
            }
            if (Array.isArray(v)) {
                for (let i = 0; i < v.length; i++) consumeSseNode(v[i], (depth || 0) + 1);
                return;
            }
            if (typeof v === 'object') {
                consumeSseNode(v, (depth || 0) + 1);
            }
        }

        function consumeSseLine(line) {
            const s = String(line || '').trim();
            if (!s || s.indexOf('data:') !== 0) return;
            const payload = s.slice(5).trim();
            if (!payload) return;
            if (payload === '[DONE]') {
                sseFinished = true;
                return;
            }
            let obj = null;
            try {
                obj = JSON.parse(payload);
            } catch (e) {
                return;
            }
            if (!sseSampleLogged) {
                sseSampleLogged = true;
                // 只打印一次原始帧，便于协议变化时快速定位（不影响面板日志）
                try {
                    console.log('[智慧树AI][SSE 首帧]', payload.slice(0, 400));
                } catch (e) {
                }
            }
            consumeSseNode(obj, 0);
        }

        function readSseStream(res) {
            let reader = null;
            try {
                if (!res || !res.body || typeof res.body.getReader !== 'function') return;
                reader = res.body.getReader();
            } catch (e) {
                return;
            }
            const streamSeq = currentTaskSeq;   // 这条流属于哪个任务
            const dec = new TextDecoder();
            let buf = '';

            function pump() {
                reader.read().then(function (r) {
                    // 任务已经切换（上一轮的下发残留）或当前空闲（用户在页面上手动聊天）：
                    // 丢弃剩余内容，避免串到别处
                    if (streamSeq !== currentTaskSeq || !busy) {
                        try {
                            reader.cancel();
                        } catch (e) {
                        }
                        return;
                    }
                    if (r.done) {
                        if (buf) consumeSseLine(buf);
                        onSseEnd();
                        return;
                    }
                    buf += dec.decode(r.value, {stream: true});
                    const lines = buf.split('\n');
                    buf = lines.pop();
                    for (let i = 0; i < lines.length; i++) consumeSseLine(lines[i]);
                    if (sseFinished) {
                        onSseEnd();
                        return;
                    }
                    pump();
                }).catch(function () {
                    onSseEnd();
                });
            }

            pump();
        }

        function hookWorkerStream() {
            if (sseHooked) return;
            const w = pageWindow;
            if (!w || typeof w.fetch !== 'function') return;
            sseHooked = true;
            const orig = w.fetch;
            w.fetch = new Proxy(orig, {
                apply: function (target, thisArg, args) {
                    const p = Reflect.apply(target, thisArg, args);
                    try {
                        const input = args[0];
                        const url = typeof input === 'string' ? input : (input && input.url) || '';
                        // 只处理「脚本下发任务期间」的请求，用户自己聊天不拦截；
                        // 不按接口路径过滤（版本会变），一律看响应的 content-type 是否为事件流
                        if (busy) {
                            p.then(function (res) {
                                try {
                                    if (!res || !res.body) return;
                                    const headers = res.headers;
                                    const ct = (headers && headers.get && headers.get('content-type')) || '';
                                    if (ct.indexOf('event-stream') === -1) return;
                                    try {
                                        console.log('[智慧树AI][流式响应]', url, ct);
                                    } catch (e) {
                                    }
                                    // 必须在页面自己消费之前 clone，否则 body 被锁定
                                    readSseStream(res.clone());
                                } catch (e) {
                                }
                            }).catch(function () {
                            });
                        }
                    } catch (e) {
                    }
                    return p;
                }
            });
        }

        // 兜底：若某天 DeepSeek 改用 XHR 做流式，这里同样能边收边解析
        function hookWorkerXhr() {
            const w = pageWindow;
            if (!w || !w.XMLHttpRequest) return;
            const X = w.XMLHttpRequest;
            if (!X.prototype || !X.prototype.send) return;
            const origSend = X.prototype.send;
            X.prototype.send = new Proxy(origSend, {
                apply: function (target, thisArg, args) {
                    try {
                        if (busy) {
                            let lastLen = 0;
                            const sendSeq = currentTaskSeq;
                            thisArg.addEventListener('readystatechange', function () {
                                try {
                                    if (sendSeq !== currentTaskSeq || !busy) return;
                                    if (thisArg.readyState < 3) return;
                                    const ct = thisArg.getResponseHeader('content-type') || '';
                                    if (ct.indexOf('event-stream') === -1) return;
                                    const text = thisArg.responseText || '';
                                    if (text.length <= lastLen) return;
                                    const chunk = text.slice(lastLen);
                                    lastLen = text.length;
                                    chunk.split('\n').forEach(consumeSseLine);
                                    if (sseFinished) onSseEnd();
                                } catch (e) {
                                }
                            });
                        }
                    } catch (e) {
                    }
                    return Reflect.apply(target, thisArg, args);
                }
            });
        }

        hookWorkerStream();
        hookWorkerXhr();
        log('已挂载流式响应拦截（后台标签页也能实时收答案）');

        let lastTaskSeq = {exam: 0, fz: 0};
        let claimedSeq = {exam: 0, fz: 0};   // 已回传过答案的任务序号（持久化），刷新后不再重复提问
        ['exam', 'fz'].forEach(function (k) {
            try {
                claimedSeq[k] = Number(GM_getValue(SITES[k].claimedKey, 0)) || 0;
            } catch (e) {
            }
        });
        let busy = false;
        let queuedTask = null;
        let lastActivity = Date.now();
        let relayStarted = false;

        let lastText = '';
        let domText = '';         // DOM 通道最新文本（后台渲染已由 rAF 补丁保证）
        let thinkWrapCache = null;
        let baselineNode = null;
        let baselineHTML = null;
        let lastChangeTime = 0;
        let doneSent = false;
        let lastRelayAt = 0;
        let tsSeq = Date.now();
        let lastStorageWrite = 0;

        let currentTaskSeq = 0;
        let currentSite = 'exam';
        let currentMode = 'qa';

        function acceptTask(task, siteKey) {
            if (!task || !task.seq || task.seq <= lastTaskSeq[siteKey]) return;
            // 该任务已回传过答案（可能是刷新前完成的）：不再重复提问，避免刷新页面自动重发旧问题
            if (task.seq <= claimedSeq[siteKey]) return;
            lastTaskSeq[siteKey] = task.seq;
            // 真正开始干活前先打开保活，避免长时间生成时被浏览器冻结/节流
            ensureKeepAlive();
            // 回执：告知面板本工作页已接管任务，面板据此复用标签页而不再重复新开
            try {
                GM_setValue(SITES[siteKey].ackKey, JSON.stringify({seq: task.seq, ts: Date.now()}));
            } catch (e) {
            }
            lastActivity = Date.now();
            if (busy) {
                queuedTask = {task: task, siteKey: siteKey};
                log('忙碌中，任务已排队', task.seq);
            } else {
                runTask(task, siteKey);
            }
        }

        function runTask(task, siteKey) {
            const start = function () {
                busy = true;
                doneSent = false;
                lastText = '';
                domText = '';
                lastRelayAt = 0;
                thinkWrapCache = null;
                currentTaskSeq = task.seq;
                currentSite = siteKey;
                currentMode = task.mode || 'qa';
                resetSse();

                const outs = document.querySelectorAll('.ds-markdown');
                baselineNode = outs.length ? outs[outs.length - 1] : null;
                baselineHTML = baselineNode ? baselineNode.innerHTML : null;
                lastChangeTime = Date.now();
                lastActivity = Date.now();
                log('开始任务', task.seq + ' 站点=' + siteKey + ' 模式=' + currentMode);
                startRelay();
                autoSend(task.text, task.targetLang, currentMode);
            };
            if (document.body) start();
            else document.addEventListener('DOMContentLoaded', start, {once: true});
        }

        function finishTask() {
            busy = false;
            lastActivity = Date.now();
            if (queuedTask) {
                const q = queuedTask;
                queuedTask = null;
                setTimeout(() => acceptTask(q.task, q.siteKey), 800);
            }
        }

        function bootWorker() {
            ['exam', 'fz'].forEach(function (siteKey) {
                try {
                    const raw = GM_getValue(SITES[siteKey].taskKey, null);
                    if (raw) {
                        const task = JSON.parse(raw);
                        if (task && task.seq && Date.now() - task.seq < CONFIG.aiTimeoutMs) {
                            acceptTask(task, siteKey);
                        }
                    }
                } catch (e) {
                    log('读取初始任务失败(' + siteKey + ')', e);
                }
            });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', bootWorker);
        } else {
            bootWorker();
        }

        if (typeof GM_addValueChangeListener === 'function') {
            ['exam', 'fz'].forEach(function (siteKey) {
                GM_addValueChangeListener(SITES[siteKey].taskKey, function (name, oldValue, newValue) {
                    try {
                        acceptTask(JSON.parse(newValue), siteKey);
                    } catch (e) {
                        log('任务解析失败(' + siteKey + ')', e);
                    }
                });
            });
        }

        // 心跳同时写两个站点的键，任一面板都能检测到工作页存活
        try {
            GM_setValue(SITES.exam.heartbeatKey, Date.now());
            GM_setValue(SITES.fz.heartbeatKey, Date.now());
        } catch (e) {
        }
        setInterval(() => {
            try {
                GM_setValue(SITES.exam.heartbeatKey, Date.now());
                GM_setValue(SITES.fz.heartbeatKey, Date.now());
            } catch (e) {
            }
        }, CONFIG.heartbeatInterval);

        // 用户手动关闭标签页时心跳不会自己过期（面板还会以为它活着），
        // 这里在卸载时主动清零，让面板立刻知道「工作页已不在」，从而直接重开。
        ['pagehide', 'beforeunload'].forEach(function (t) {
            window.addEventListener(t, function () {
                try {
                    GM_setValue(SITES.exam.heartbeatKey, 0);
                    GM_setValue(SITES.fz.heartbeatKey, 0);
                } catch (e) {
                }
            });
        });

        setInterval(() => {
            if (!busy && (lastTaskSeq.exam || lastTaskSeq.fz) && Date.now() - lastActivity > CONFIG.workerIdleCloseMs) {
                log('空闲超时，自动关闭工作标签页');
                // 通知持有本 tab 的父页面主动 close（GM_openInTab 打开时 window.close 可能被拦）
                try {
                    GM_setValue(SITES[currentSite].closeKey, JSON.stringify({
                        ts: Date.now(),
                        workerName: CONFIG.workerName
                    }));
                } catch (e) {
                }
                // 关闭前清心跳，避免面板误判「仍然存活」而不重新开标签页
                try {
                    GM_setValue(SITES.exam.heartbeatKey, 0);
                    GM_setValue(SITES.fz.heartbeatKey, 0);
                } catch (e) {
                }
                try {
                    window.close();
                } catch (e) {
                }
            }
        }, 15000);

        // ---------- 回传 ----------
        function nextTs() {
            tsSeq = Math.max(tsSeq + 1, Date.now());
            return tsSeq;
        }

        function relayMessage(payload) {
            const cfg = SITES[currentSite];
            const full = Object.assign({
                source: cfg.relaySource,
                ts: nextTs(),
                taskSeq: currentTaskSeq,
                mode: currentMode
            }, payload);

            try {
                const now = Date.now();
                // 长答案的文本体积较大，写库节流放宽到 150ms，降低跨标签同步压力
                if (payload.done || payload.error || now - lastStorageWrite > 150) {
                    lastStorageWrite = now;
                    GM_setValue(cfg.relayKey, JSON.stringify(full));
                }
            } catch (e) {
                log('GM 存储回传失败', e);
            }

            try {
                if (window.opener && !window.opener.closed) {
                    window.opener.postMessage(full, '*');
                }
            } catch (e) {
                log('postMessage 回传失败', e);
            }
        }

        function relayError(msg) {
            log('错误：' + msg);
            relayMessage({error: msg});
        }

        // 只有真正把答案回传出去的任务才算「已完成」：这样工作页被浏览器丢弃并重载后，
        // 未完成的任务还能重新提问；已完成的任务也不会被重复提问。
        function markClaimed(seq, siteKey) {
            if (!seq || !siteKey) return;
            claimedSeq[siteKey] = seq;
            try {
                GM_setValue(SITES[siteKey].claimedKey, seq);
            } catch (e) {
            }
        }

        function startRelay() {
            if (relayStarted) return;
            relayStarted = true;

            function detectThinkWrap() {
                const hints = document.querySelectorAll('div,button,span');
                for (const el of hints) {
                    const t = (el.textContent || '').trim();
                    if (t.length === 0 || t.length > 30) continue;
                    if (!/已深度思考|思考过程|思考中|思考完毕|已搜索到|联网搜索/.test(t)) continue;
                    let p = el.parentElement;
                    while (p && p !== document.body) {
                        if (p.querySelector('.ds-markdown')) {
                            if (!p.matches('.ds-markdown')) return p;
                            break;
                        }
                        p = p.parentElement;
                    }
                }
                return null;
            }

            function getThinkWrap() {
                if (thinkWrapCache && thinkWrapCache.isConnected) return thinkWrapCache;
                thinkWrapCache = detectThinkWrap();
                return thinkWrapCache;
            }

            // 答案节点选择器：DeepSeek 改版后类名可能变化，逐级降级查找
            function getAnswerNodes() {
                let nodes = Array.from(document.querySelectorAll('.ds-markdown'));
                if (!nodes.length) nodes = Array.from(document.querySelectorAll('[class*="ds-markdown"]'));
                if (!nodes.length) nodes = Array.from(document.querySelectorAll('[class*="markdown"]'));
                if (!nodes.length) {
                    const msgs = document.querySelectorAll('[class*="message"], [data-testid*="message"]');
                    if (msgs.length) nodes = [msgs[msgs.length - 1]];
                }
                return nodes;
            }

            /**
             * 收集本轮回答的全部片段。
             * DeepSeek 遇到长回答（多段正文 / 代码块 / 搜索引用）时会拆成多个 markdown 节点，
             * 只取最后一个节点会导致解析不到完整 JSON，所以这里按基线节点之后的全部节点拼接。
             */
            function collectAnswerText() {
                const outputs = getAnswerNodes();
                if (!outputs.length) return null;
                const thinkWrap = getThinkWrap();
                const usable = outputs.filter(el => !(thinkWrap && thinkWrap.contains(el)));

                let picked = [];
                const baseIdx = baselineNode ? outputs.indexOf(baselineNode) : -1;
                if (baseIdx !== -1) {
                    // 基线节点仍在（同一对话内继续输出）：只取它之后的节点
                    picked = outputs.slice(baseIdx + 1).filter(el => !(thinkWrap && thinkWrap.contains(el)));
                } else {
                    // 基线节点已被移除（点「新对话」后整轮重绘）：当前所有节点都属于本轮回答
                    picked = usable;
                }

                if (!picked.length) {
                    // 尚未产生新节点：最后一个节点就是基线且内容没变，说明回答还没开始
                    const last = usable[usable.length - 1];
                    if (!last) return null;
                    if (last === baselineNode && last.innerHTML === baselineHTML) return null;
                    picked = [last];
                }

                const text = picked.map(el => el.textContent || '').join('\n');
                if (!text.trim()) return null;
                return {nodes: picked, text: text};
            }

            let relayScheduled = false;
            let lastCollectAt = 0;

            function collectAndRelay() {
                lastCollectAt = Date.now();
                if (!busy) return;
                const answer = collectAnswerText();
                if (!answer || !answer.text) return;
                // DOM 通道只负责更新 domText，是否回传、回传哪一路由 flushRelay 统一择优
                domText = answer.text;
                flushRelay(false);
            }

            /**
             * MutationObserver 回调不受后台定时器节流影响，所以能立刻取值时就立刻回传，
             * 只有高频抖动时才用 120ms 合并；这样即使后台标签页的定时器被拖到 1 次/分钟，
             * 面板依然能持续收到最新文本，不必等定时器。
             */
            function scheduleRelayCheck() {
                if (Date.now() - lastCollectAt >= 120) {
                    collectAndRelay();
                    return;
                }
                if (relayScheduled) return;
                relayScheduled = true;
                setTimeout(function () {
                    relayScheduled = false;
                    collectAndRelay();
                }, 120);
            }

            if (document.body) {
                const mo = new MutationObserver(scheduleRelayCheck);
                mo.observe(document.body, {childList: true, subtree: true, characterData: true});
            }

            setInterval(() => {
                if (!busy) return;
                const picked = chooseText();
                if (!picked.text) return;
                flushRelay(false);
                if (doneSent) return;

                const idle = Date.now() - lastChangeTime;
                if (idle < 800) return;

                const ready = currentMode === 'qa'
                    ? looksLikeAnswerJson(picked.text)
                    : /\{[\s\S]*\}/.test(picked.text);

                // 已有完整可解析的答案：文本稳定 2s 即可回传完成（原来要等 6s 且可能被抖动拖死）
                if (ready) {
                    if (idle < 2000) return;
                    finishRelay();
                    return;
                }

                // 还解析不出答案：给足宽限（防止深度思考 / 长回答中途停顿被误判）。
                // 超过宽限仍无答案才回传一次 done，并允许后续内容变化时再次判定。
                const graceMs = CONFIG.doneIdleMs + (currentMode === 'qa' ? CONFIG.aiMinWaitMs : CONFIG.noJsonGraceMs);
                if (idle < graceMs) return;
                log('未解析到答案，先回传当前内容（若后续补齐会再次回传）');
                try {
                    console.warn('[智慧树AI][无法解析的文本前 300 字]', picked.text.slice(0, 300));
                } catch (e) {
                }
                finishRelay();
            }, 300);
        }

        // ---------- 自动发送 ----------
        function autoSend(text, targetLang, mode) {
            let prompt;
            if (mode === 'qa') {
                prompt = text;
            } else {
                prompt = `仅输出${targetLang}译文：
"""
${text}
"""

输出示例：
The translated text itself`;
            }

            log('提示词已构建 (模式=' + mode + ')');

            function findInput() {
                let input = document.querySelector('textarea[name="search"]');
                if (input) return input;
                input = document.querySelector('textarea.d96f2d2a');
                if (input) return input;
                return document.querySelector('textarea');
            }

            function findSendButton() {
                const candidates = document.querySelectorAll('div[role="button"]');
                for (let btn of candidates) {
                    const svg = btn.querySelector('svg');
                    if (svg) {
                        const path = svg.querySelector('path[d^="M8.3125"]');
                        if (path) return btn;
                    }
                }
                for (let btn of candidates) {
                    if (!btn.classList.contains('ds-button--disabled')) return btn;
                }
                return null;
            }

            function fillInput(input, value) {
                input.focus();
                const nativeSetter = Object.getOwnPropertyDescriptor(
                    HTMLTextAreaElement.prototype, 'value'
                ).set;
                nativeSetter.call(input, value);
                ['input', 'change', 'keydown', 'keyup'].forEach(type => {
                    input.dispatchEvent(new Event(type, {bubbles: true, cancelable: true}));
                });
                input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
                input.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: value}));
                log('输入框已填充');
            }

            function clickSendButton(btn, input) {
                return new Promise((resolve) => {
                    if (btn.classList.contains('ds-button--disabled')) {
                        log('发送按钮禁用，等待启用...');
                        const observer = new MutationObserver(() => {
                            if (!btn.classList.contains('ds-button--disabled')) {
                                observer.disconnect();
                                btn.click();
                                log('点击发送按钮');
                                resolve();
                            }
                        });
                        observer.observe(btn, {attributes: true, attributeFilter: ['class']});
                        setTimeout(() => {
                            observer.disconnect();
                            if (btn.classList.contains('ds-button--disabled')) {
                                log('发送按钮超时未启用');
                                relayError('DeepSeek 发送按钮未就绪，请重试');
                                finishTask();
                                resolve();
                            }
                        }, 5000);
                    } else {
                        btn.click();
                        log('点击发送按钮');
                        resolve();
                    }
                });
            }

            async function waitFor(fn, timeout) {
                const start = Date.now();
                while (Date.now() - start < timeout) {
                    const el = fn();
                    if (el) return el;
                    await sleep(250);
                }
                return null;
            }

            (async function () {
                const newBtn = document.querySelector('button[aria-label="新对话"], button[aria-label="新建对话"], .new-chat-btn');
                if (newBtn) newBtn.click();

                await sleep(300);

                const input = await waitFor(function () {
                    const el = findInput();
                    return (el && !el.disabled) ? el : null;
                }, 15000);
                if (!input) {
                    relayError('DeepSeek 页面未找到输入框，请点击"AI 答题助手"标签页确认已登录');
                    finishTask();
                    return;
                }

                fillInput(input, prompt);
                await sleep(400);

                const sendBtn = await waitFor(findSendButton, 10000);
                if (sendBtn) {
                    await clickSendButton(sendBtn, input);
                } else {
                    relayError('未找到发送按钮，请重试');
                    finishTask();
                }
            })();
        }
    }

})();
