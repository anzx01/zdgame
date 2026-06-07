"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

loadDotEnv();

const ROOT = __dirname;
const LOG_FILE = path.join(ROOT, "server.log");
const PORT = Number(process.env.PORT || 8787);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 2_000_000);
const DEEPSEEK_BASE_URL = trimTrailingSlash(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com");
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
const DEEPSEEK_FALLBACK_MODEL = process.env.DEEPSEEK_FALLBACK_MODEL || "deepseek-v4-flash";
const DEEPSEEK_THINKING = process.env.DEEPSEEK_THINKING || "enabled";
const DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || "high";
const DEEPSEEK_MAX_TOKENS = Number(process.env.DEEPSEEK_MAX_TOKENS || 24000);
const DEEPSEEK_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 420000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const generatorInstructions = `
你是一个“单文件浏览器小游戏生成器”。你的唯一任务是生成完整、可直接保存为 index.html 并在浏览器运行的小游戏。

硬性要求：
- 只输出完整 HTML 文档，不要 Markdown 代码围栏，不要解释，不要额外文本。
- 必须包含 <!doctype html>、<html>、<head>、<style>、<body> 和 <script>。
- 使用纯 HTML/CSS/JavaScript，不使用外部库，不加载外部资源，不依赖网络。
- 使用 <canvas> 或 DOM/CSS 实现游戏画面，游戏循环优先使用 requestAnimationFrame。
- 游戏必须有完整玩法闭环：玩家控制、核心规则、障碍或敌人、计分/HUD、胜负条件、重新开始按钮。
- 视觉风格要清晰、可爱、2D、颜色鲜明；动画反馈要可见。
- 代码结构要清晰，便于继续修改。
- 键盘操作要阻止页面滚动；游戏结束或胜利后必须能重新开始。
- 生成的游戏会在 iframe Blob URL 预览中运行；不要使用 import、export、type="module"、fetch、localStorage、sessionStorage、Web Worker、外链字体或外链图片。
- 所有初始化代码必须等待 DOM 可用或放在 body 末尾；如果使用 canvas，必须设置明确 width/height，并在第一帧立刻绘制非空画面。
- 不要引用不存在的 DOM id、图片、音频或资源；不要让任何启动异常导致白屏。
- body 中必须有可见的游戏标题、HUD 或开始界面作为兜底，即使 canvas 绘制失败也不能是纯白空页面。
- 如果生成推箱子、迷宫、解谜或关卡制益智游戏，所有关卡必须可解；不要把目标点放在只能从墙内侧推动的位置；关卡数据旁要用简短注释写一条示例解法或设计意图。

输出内容必须是最终 HTML，不要出现“下面是代码”等说明。
`.trim();

const difficultyInstructions = `
Difficulty rules:
- Default to beginner-friendly gameplay unless the user explicitly asks for hard mode.
- For Snake games, use a slow initial tick, large readable grid cells, gentle speed growth, pause/restart controls, and optional Easy/Normal/Hard difficulty selection.
- For reaction games, shooters, dodgers, and arcade games, begin slowly and increase difficulty gradually.
- Avoid failure in the first few seconds unless the player makes a clear mistake.
- When modifying an existing game because it is too hard, reduce speed, soften acceleration, add difficulty controls, and keep the original visual style.
`.trim();

function buildGeneratePrompt(gameName, extraRequirements) {
  return `
用户输入的游戏名称：${gameName}

请把这个一句话需求自动扩展成完整小游戏需求并实现。

默认规格：
- 生成一个可直接在浏览器运行的“${gameName}”网页游戏。
- 使用完整单文件 HTML 实现。
- 包含完整玩家控制、核心玩法规则、关卡或难度递增、计分/HUD、胜负条件、重新开始按钮和清晰可爱的 2D 动画效果。
- 游戏要尽量完整好玩，而不是静态演示。
- 必须保证打开后首屏不是白屏：立即显示标题、HUD、画布或棋盘，并且即使等待用户按键也要有可见场景。
- 首屏必须至少包含一个非白背景区域和可见文本，不能只依赖后续异步逻辑才显示内容。
- 如果是推箱子游戏，前 3 关必须非常明确可解，避免箱子贴死角、目标侧面被墙封死、玩家无法到达推箱所需站位。

用户补充要求：
${extraRequirements || "无"}
`.trim();
}

function buildModifyPrompt(title, html, instruction) {
  return `
请修改下面这个已经生成的单文件 HTML 游戏。

游戏标题：${title}
修改要求：${instruction}

规则：
- 保留完整可运行的单文件 HTML 结构。
- 只按修改要求更新游戏，不要删除无关核心功能。
- 如果修改涉及玩法，请同步更新 HUD、胜负条件或说明按钮文案。
- 修复后必须能在 iframe Blob URL 预览中直接显示首屏画面，避免白屏。
- 只输出修改后的完整 HTML，不要 Markdown，不要解释。

当前 HTML：
<<<HTML_START
${html}
HTML_END>>>
`.trim();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      return sendNoContent(res);
    }

    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, {
        ok: true,
        provider: "deepseek",
        model: DEEPSEEK_MODEL,
        fallbackModel: DEEPSEEK_FALLBACK_MODEL,
        baseUrl: DEEPSEEK_BASE_URL,
        hasKey: Boolean(process.env.DEEPSEEK_API_KEY)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/generate") {
      const body = await readJson(req);
      const gameName = normalizeShortText(body.gameName, "gameName", 80);
      const extraRequirements = normalizeOptionalText(body.extraRequirements, 1200);

      const generated = await requestGameHtml([
        { role: "system", content: `${generatorInstructions}\n\n${difficultyInstructions}` },
        { role: "user", content: buildGeneratePrompt(gameName, extraRequirements) }
      ]);

      return sendJson(res, { html: generated.html, model: generated.model });
    }

    if (req.method === "POST" && url.pathname === "/api/modify") {
      const body = await readJson(req);
      const title = normalizeShortText(body.title, "title", 120);
      const instruction = normalizeShortText(body.instruction, "instruction", 1200);
      const htmlInput = normalizeHtmlInput(body.html);

      const generated = await requestGameHtml([
        { role: "system", content: `${generatorInstructions}\n\n${difficultyInstructions}` },
        { role: "user", content: buildModifyPrompt(title, htmlInput, instruction) }
      ]);

      return sendJson(res, { html: generated.html, model: generated.model });
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    return sendJson(res, { error: "Method not allowed" }, 405);
  } catch (error) {
    const status = error.statusCode || 500;
    const message = status >= 500 ? "服务器处理失败" : error.message;
    if (status >= 500) logError(error);
    if (res.destroyed || res.writableEnded) return;
    return sendJson(res, { error: message, detail: error.publicDetail || undefined }, status);
  }
});

server.requestTimeout = DEEPSEEK_TIMEOUT_MS + 30000;
server.headersTimeout = DEEPSEEK_TIMEOUT_MS + 60000;
server.timeout = DEEPSEEK_TIMEOUT_MS + 30000;

server.listen(PORT, () => {
  console.log(`AI game generator running at http://localhost:${PORT}`);
  console.log(`Provider: DeepSeek, model: ${DEEPSEEK_MODEL}`);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log("DEEPSEEK_API_KEY is not set. Generation endpoints will return an error until it is configured.");
  }
});

function serveStatic(pathname, res) {
  const safePath = decodeURIComponent(pathname);
  let filePath = null;

  if (safePath === "/" || safePath === "/index.html") {
    filePath = path.join(ROOT, "index.html");
  } else if (safePath.startsWith("/samples/")) {
    filePath = path.join(ROOT, safePath);
  }

  if (!filePath || !isInside(ROOT, filePath)) {
    return sendJson(res, { error: "Not found" }, 404);
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, { error: "Not found" }, 404);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

async function requestGameHtml(messages) {
  const models = [DEEPSEEK_MODEL];
  if (DEEPSEEK_FALLBACK_MODEL && DEEPSEEK_FALLBACK_MODEL !== DEEPSEEK_MODEL) {
    models.push(DEEPSEEK_FALLBACK_MODEL);
  }

  let lastError = null;
  for (const model of models) {
    try {
      const html = await requestGameHtmlWithModel(messages, model);
      return { html, model };
    } catch (error) {
      lastError = error;
      if (!isRetryableDeepSeekError(error) || model === models[models.length - 1]) {
        throw error;
      }
      logError(new Error(`DeepSeek model ${model} failed, retrying with ${models[models.indexOf(model) + 1]}: ${error.message}`));
    }
  }

  throw lastError;
}

async function requestGameHtmlWithModel(messages, model) {
  if (!process.env.DEEPSEEK_API_KEY) {
    const error = new Error("缺少 DEEPSEEK_API_KEY。请先在终端设置 DeepSeek API Key。");
    error.statusCode = 400;
    throw error;
  }

  if (typeof fetch !== "function") {
    const error = new Error("当前 Node 版本没有内置 fetch，请使用 Node 18 或更新版本。");
    error.statusCode = 500;
    throw error;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages,
        thinking: { type: DEEPSEEK_THINKING },
        reasoning_effort: DEEPSEEK_REASONING_EFFORT,
        max_tokens: DEEPSEEK_MAX_TOKENS,
        temperature: 0.65,
        stream: false
      })
    });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("DeepSeek 生成超时，请稍后重试或降低模型/输出长度。");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const rawText = await response.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const detail = data?.error?.message || rawText.slice(0, 500) || response.statusText;
    const error = new Error(`DeepSeek 请求失败：${response.status}`);
    error.statusCode = response.status === 401 ? 401 : 502;
    error.publicDetail = detail;
    throw error;
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    const error = new Error("DeepSeek 没有返回可用的 HTML 内容。");
    error.statusCode = 502;
    throw error;
  }

  return cleanAndValidateHtml(content);
}

function isRetryableDeepSeekError(error) {
  if (!error.statusCode) return true;
  return error.statusCode === 502 || error.statusCode === 504 || error.statusCode >= 500;
}

function cleanAndValidateHtml(text) {
  let html = text.trim();
  html = html.replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const lower = html.toLowerCase();
  const doctypeIndex = lower.indexOf("<!doctype");
  const htmlIndex = lower.indexOf("<html");
  const start = doctypeIndex >= 0 ? doctypeIndex : htmlIndex;
  const end = lower.lastIndexOf("</html>");

  if (start >= 0 && end >= 0) {
    html = html.slice(start, end + "</html>".length).trim();
  }

  const finalLower = html.toLowerCase();
  if (!finalLower.includes("<html") || !finalLower.includes("</html>")) {
    const error = new Error("AI 返回内容不是完整 HTML，未覆盖原游戏。");
    error.statusCode = 502;
    throw error;
  }
  if (!finalLower.includes("<style") || !finalLower.includes("<script")) {
    const error = new Error("AI 返回的 HTML 缺少 style 或 script，未覆盖原游戏。");
    error.statusCode = 502;
    throw error;
  }

  return html;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        const error = new Error("请求内容过大。");
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        const error = new Error("请求 JSON 格式无效。");
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function normalizeShortText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${field} 不能为空。`);
    error.statusCode = 400;
    throw error;
  }
  const text = value.trim();
  if (text.length > maxLength) {
    const error = new Error(`${field} 不能超过 ${maxLength} 个字符。`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function normalizeOptionalText(value, maxLength) {
  if (value == null) return "";
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function normalizeHtmlInput(value) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error("html 不能为空。");
    error.statusCode = 400;
    throw error;
  }
  if (Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES - 20_000) {
    const error = new Error("HTML 内容过大，无法提交给 AI 修改。");
    error.statusCode = 413;
    throw error;
  }
  return value;
}

function sendJson(res, payload, statusCode = 200) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end();
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function isInside(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function logError(error) {
  const line = [
    new Date().toISOString(),
    error && error.stack ? error.stack : String(error)
  ].join(" ");
  console.error(error);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {}
}

process.on("uncaughtException", (error) => {
  logError(error);
});

process.on("unhandledRejection", (error) => {
  logError(error);
});
