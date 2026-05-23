const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const { Anthropic } = require("@anthropic-ai/sdk");
require("dotenv").config();

const PORT = 3000;
const ROOT = __dirname;

// ---------- 加载 API 配置 ----------

function loadApiConfig() {
  // 优先 .env 文件
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    };
  }

  // 回退：读取 Claude Code 的 settings.json
  try {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    if (settings.env && settings.env.ANTHROPIC_AUTH_TOKEN) {
      return {
        apiKey: settings.env.ANTHROPIC_AUTH_TOKEN,
        baseURL: settings.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
        model: (settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL || settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "claude-sonnet-4-6").replace(/\[.*\]/, ""),
      };
    }
  } catch (_) {}

  console.error("未找到 API 配置。请创建 .env 文件并设置 ANTHROPIC_API_KEY");
  console.error("cp .env.example .env  # 然后编辑 .env 填入密钥");
  process.exit(1);
}

const apiConfig = loadApiConfig();
console.log(`  API: ${apiConfig.baseURL}`);
console.log(`  Model: ${apiConfig.model}\n`);

const anthropic = new Anthropic({
  apiKey: apiConfig.apiKey,
  baseURL: apiConfig.baseURL,
});

// ---------- 加载静态资源 ----------

const platformRules   = fs.readFileSync(path.join(ROOT, "platform_rules.md"), "utf-8");
const promptTemplate  = fs.readFileSync(path.join(ROOT, "prompt_template.md"), "utf-8");
const csvData         = fs.readFileSync(path.join(ROOT, "mock_data", "activities_100.csv"), "utf-8");

// 解析 CSV
function parseCSV(raw) {
  const lines = raw.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim());
    const row = {};
    headers.forEach((h, j) => { row[h] = cols[j] || ""; });
    rows.push(row);
  }
  return rows;
}
const activityDB = parseCSV(csvData);

function findActivity(id) {
  return activityDB.find(r => r.activity_id === id);
}

// ---------- Prompt 组装 ----------

function buildSystemPrompt(platforms) {
  // 从 prompt_template.md 中提取 System Prompt 部分（去掉 {{PLATFORM_RULES}} 占位符）
  const sysPrompt = [
    "你是资深多平台宣传文案专家。你的任务是把一份活动资料转化为适配不同社交媒体平台的宣传文案。",
    "",
    "## 核心职责",
    "1. 忠实保留活动事实信息（名称、时间、地点、嘉宾、卖点、报名方式），绝不编造或改动",
    "2. 为每个平台生成风格明显不同的文案，禁止同一段正文简单复制",
    "3. 不确定的时间、价格、名额、链接必须标记'待确认'",
    "4. 每个平台输出必须说明生成依据",
    "",
    "## 平台风格规则",
    platformRules,
    "",
    "## 输出格式要求",
    "先输出'一句话传播主张：xxx'，然后为每个平台用 '### 平台名' 作为标题分隔。",
    "每个平台严格按以下格式输出：",
    "- **推荐标题**：xxx",
    "- **正文文案**：xxx",
    "- **核心卖点**：xxx",
    "- **CTA**：xxx",
    "- **Hashtag**：xxx",
    "- **发布建议**：xxx",
    "- **生成依据**：xxx",
    "- **需人工确认项**：xxx",
    "",
    "最后输出：跨平台一致性检查结果和人工确认清单。",
  ].join("\n");
  return sysPrompt;
}

function buildUserPrompt(activity, platforms) {
  return [
    "## 活动信息",
    `- 活动名称：${activity.activity_name}`,
    `- 行业/主题：${activity.industry}`,
    `- 目标人群：${activity.target_audience}`,
    `- 宣传目标：${activity.objective}`,
    `- 活动亮点：${activity.key_selling_points}`,
    `- 活动时间：${activity.activity_time || "待确认"}`,
    `- 活动形式/地点：${activity.location || "待确认"}`,
    `- 主讲人/嘉宾：${activity.speaker || "待确认"}`,
    `- 报名方式：${activity.signup_method}`,
    `- 语气要求：${activity.tone_hint}`,
    `- 限制/禁用表达：${activity.constraints || "无"}`,
    "",
    "## 需要生成的平台",
    platforms.join("、"),
    "",
    "## 输出要求",
    "1. 先输出一句话传播主张（30字以内）",
    "2. 再为每个平台按 ### 分隔输出完整文案",
    "3. 最后输出跨平台一致性检查结果和人工确认清单",
    "",
    "## 约束",
    "- 不同平台文案必须风格明显区分，不能简单复制",
    `- 不确定的信息标记'待确认'`,
    `- 遵守限制条件：${activity.constraints || "无"}`,
    "- 禁止使用 AI 写作禁词（深入探讨、探索之旅、不容错过、重磅来袭、delve into、explore、journey、exciting、amazing、revolutionary、game-changer 等）",
    "- 叙事标题代替标签式标题",
  ].join("\n");
}

// ---------- 解析 LLM 输出 ----------

function parseOutput(raw) {
  // 提取一句话传播主张
  let slogan = "";
  const sloganPatterns = [
    /##\s*一句话传播主张[：:]?\s*\n*(.+?)(?:\n|$)/i,
    /一句话传播主张[：:]\s*(.+?)(?:\n|$)/i,
    /传播主张[：:]\s*(.+?)(?:\n|$)/i,
  ];
  for (const re of sloganPatterns) {
    const m = raw.match(re);
    if (m) { slogan = m[1].trim(); break; }
  }

  // 平台名称列表
  const platformNames = ["公众号", "小红书", "朋友圈", "抖音", "X", "微博"];
  const fieldNames = ["推荐标题", "正文文案", "核心卖点", "CTA", "Hashtag", "话题", "发布建议", "生成依据", "需人工确认项"];

  // 按 ### 后跟平台名或直接换行来分割
  const sections = raw.split(/\n(?=###\s)/);
  let platforms = [];

  for (const section of sections) {
    // 识别该段对应哪个平台
    let pName = null;
    const headerMatch = section.match(/^###\s*(.+)/);
    if (headerMatch) {
      pName = platformNames.find(n => headerMatch[1].startsWith(n));
    }
    if (!pName) continue;

    // 提取各字段
    const fields = {};
    for (const field of fieldNames) {
      // 匹配各种格式：- **字段**：xxx / **字段**  \nxxx / **字段**：xxx
      let val = "";
      const patterns = [
        new RegExp(`[-\\*]*\\s*\\*\\*${field}\\*\\*[：:]\\s*(.+?)(?:\\n[-\\*\\s]*\\*\\*|$)`, "s"),
        new RegExp(`[-\\*]*\\s*\\*\\*${field}\\*\\*\\s*\\n\\s*(.+?)(?:\\n\\s*\\n|$)`, "s"),
        new RegExp(`[-\\*]*\\s*${field}[：:]\\s*(.+?)(?:\\n\\s*\\n|$)`, "s"),
      ];
      for (const re of patterns) {
        const m = section.match(re);
        if (m) { val = m[1].trim(); break; }
      }
      fields[field] = val;
    }

    platforms.push({
      name: pName,
      title: fields["推荐标题"] || "",
      body: fields["正文文案"] || "",
      sellingPoints: fields["核心卖点"] || "",
      cta: fields["CTA"] || "",
      hashtags: fields["Hashtag"] || fields["话题"] || "",
      publishTip: fields["发布建议"] || "",
      basis: fields["生成依据"] || "",
      confirmItems: fields["需人工确认项"] || "",
    });
  }

  // 人工确认清单
  let confirmList = [];
  const confirmSection = raw.match(/(?:需)?人工确认[清单项：:\s]+([\s\S]+?)$/i);
  if (confirmSection) {
    confirmList = confirmSection[1]
      .split(/\n/)
      .filter(l => /[-*]\s*\[.\]\s*|待确认/.test(l))
      .map(l => l.replace(/^[-*\s]*\[.\]\s*/, "").trim())
      .filter(Boolean);
  }

  return { slogan, platforms, confirmList };
}

function extractField(text, pattern) {
  const re = new RegExp(`(?:^|\\n)\\s*[-\\*]*\\s*${pattern}[：:]\\s*(.+?)(?:\\n[-\\*]|$)`, "is");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

// ---------- Claude API 调用 ----------

async function generateCopy(activity, platforms) {
  const systemPrompt = buildSystemPrompt(platforms);
  const userPrompt = buildUserPrompt(activity, platforms);

  console.log("  调用 API...");
  const msg = await anthropic.messages.create({
    model: apiConfig.model,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  console.log("  完整响应 keys:", Object.keys(msg));
  console.log("  content type:", typeof msg.content);
  console.log("  content dump:", JSON.stringify(msg.content).slice(0, 800));

  // 兼容不同 API 返回格式（支持 thinking 块）
  let raw = "";
  if (typeof msg.content === "string") {
    raw = msg.content;
  } else if (Array.isArray(msg.content) && msg.content.length > 0) {
    const textBlock = msg.content.find(c => c.type === "text" && c.text);
    raw = textBlock ? textBlock.text : "";
  } else if (msg.content && msg.content.text) {
    raw = msg.content.text;
  }

  if (!raw) {
    console.error("  无法提取内容，完整响应:", JSON.stringify(msg).slice(0, 1000));
    throw new Error("API 返回内容为空，格式不兼容");
  }
  console.log("  API 返回 " + raw.length + " 字符");
  console.log("  前200字符:", raw.slice(0, 200));
  return parseOutput(raw);
}

// ---------- Markdown → WeChat HTML ----------

const SKILL_MD2HTML = path.join(
  ROOT, "..", ".agents", "skills", "baoyu-markdown-to-html", "scripts", "main.ts"
);

async function convertToWechatHtml(markdown, opts = {}) {
  const title = opts.title || "未命名";
  const theme = opts.theme || "default";
  const color = opts.color || "";

  // 写入临时 .md 文件
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-html-"));
  const mdPath = path.join(tmpDir, `${sanitizeFilename(title)}.md`);

  // 组装 frontmatter + 正文
  const mdContent = [
    "---",
    `title: ${title}`,
    "---",
    "",
    markdown,
  ].join("\n");
  fs.writeFileSync(mdPath, mdContent, "utf-8");

  // 调用 baoyu-markdown-to-html
  const cmd = [
    `npx -y bun "${SKILL_MD2HTML}"`,
    `"${mdPath}"`,
    `--theme ${theme}`,
    color ? `--color ${color}` : "",
  ].filter(Boolean).join(" ");

  console.log("  转换命令:", cmd);

  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error("  HTML 转换 stderr:", stderr);
        reject(new Error(`HTML 转换失败: ${stderr || err.message}`));
        return;
      }

      // 解析输出的 JSON
      try {
        const jsonStart = stdout.indexOf("{");
        if (jsonStart === -1) throw new Error("输出中无 JSON");
        const result = JSON.parse(stdout.slice(jsonStart));
        const htmlPath = result.htmlPath;

        let html = "";
        if (htmlPath && fs.existsSync(htmlPath)) {
          html = fs.readFileSync(htmlPath, "utf-8");
        }

        // 清理临时文件
        try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}

        resolve({
          success: true,
          html: html,
          title: result.title,
          htmlPath: result.htmlPath,
        });
      } catch (parseErr) {
        // 如果解析失败，返回 stdout 作为 HTML
        console.error("  解析输出失败:", parseErr.message);
        resolve({
          success: true,
          html: stdout.trim(),
          title: title,
        });
      }
    });
  });
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, "_").slice(0, 50);
}

// ---------- HTTP Server ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".md":   "text/plain; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204); res.end(); return;
  }

  // API
  if (req.method === "POST" && req.url === "/api/generate") {
    try {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", async () => {
        try {
          const { activity_id, platforms, activity: customActivity } = JSON.parse(body);

          let activity;
          if (activity_id) {
            activity = findActivity(activity_id);
            if (!activity) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `未找到活动 ${activity_id}` }));
              return;
            }
          } else if (customActivity) {
            activity = customActivity;
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "请提供 activity_id 或 activity 对象" }));
            return;
          }

          const result = await generateCopy(activity, platforms);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e) {
          console.error("Generate error:", e.message);
          console.error("Stack:", e.stack);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "无效的 JSON" }));
    }
    return;
  }

  // Markdown → HTML 转换
  if (req.method === "POST" && req.url === "/api/to-html") {
    try {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", async () => {
        try {
          const { markdown, title, theme, color } = JSON.parse(body);
          if (!markdown) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "请提供 markdown 内容" }));
            return;
          }

          const result = await convertToWechatHtml(markdown, { title, theme, color });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e) {
          console.error("HTML convert error:", e.message);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "无效的 JSON" }));
    }
    return;
  }

  // HTML 预览（直接返回 HTML，浏览器可渲染）
  if (req.method === "POST" && req.url === "/api/html-preview") {
    try {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", async () => {
        try {
          const { markdown, title, theme, color } = JSON.parse(body);
          if (!markdown) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<h2>请提供 markdown 内容</h2>");
            return;
          }
          const result = await convertToWechatHtml(markdown, { title, theme, color });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(result.html);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<h2>转换失败</h2><pre>${e.message}</pre>`);
        }
      });
    } catch (e) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("无效请求");
    }
    return;
  }

  // 获取活动列表
  if (req.method === "GET" && req.url === "/api/activities") {
    // 只返回摘要信息，不返回完整数据
    const summary = activityDB.map(r => ({
      activity_id: r.activity_id,
      activity_name: r.activity_name,
      industry: r.industry,
      target_audience: r.target_audience,
      platform_set: r.platform_set,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(summary));
    return;
  }

  // 静态文件
  let filePath = req.url === "/" ? "/demo.html" : req.url;
  const fullPath = path.join(ROOT, filePath);

  // 安全检查
  if (!fullPath.startsWith(ROOT)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  const ext = path.extname(fullPath);
  const contentType = MIME[ext] || "application/octet-stream";

  try {
    const content = fs.readFileSync(fullPath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`\n  AI 多平台宣传文案员工 服务已启动`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  API 端点: POST http://localhost:${PORT}/api/generate`);
  console.log(`  CSV 中共 ${activityDB.length} 条活动数据\n`);
});
