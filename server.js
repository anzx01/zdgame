"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const { URL } = require("url");

loadDotEnv();

const ROOT = __dirname;
const LOG_FILE = path.join(ROOT, "server.log");
const QUALITY_LOG_FILE = path.join(ROOT, "quality-events.jsonl");
const PORT = Number(process.env.PORT || 8787);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 2_000_000);
const MAX_THUMBNAIL_BODY_BYTES = Number(process.env.MAX_THUMBNAIL_BODY_BYTES || 8_000_000);
const DEEPSEEK_BASE_URL = trimTrailingSlash(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com");
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const DEEPSEEK_FALLBACK_MODEL = process.env.DEEPSEEK_FALLBACK_MODEL || "deepseek-v4-pro";
const DEEPSEEK_RULE_MODEL = process.env.DEEPSEEK_RULE_MODEL || "deepseek-v4-pro";
const DEEPSEEK_THINKING = process.env.DEEPSEEK_THINKING || "enabled";
const DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || "high";
const DEEPSEEK_MAX_TOKENS = Number(process.env.DEEPSEEK_MAX_TOKENS || 24000);
const DEEPSEEK_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 420000);
const SERVER_TIMEOUT_MS = Number(process.env.SERVER_TIMEOUT_MS || Math.max(DEEPSEEK_TIMEOUT_MS * 2 + 180000, 900000));
const ENABLE_BROWSER_QA = process.env.ENABLE_BROWSER_QA !== "false";
const PLAYTEST_TIMEOUT_MS = Number(process.env.PLAYTEST_TIMEOUT_MS || 14000);
const NORMAL_REPAIR_LOOPS = Number(process.env.NORMAL_REPAIR_LOOPS || 1);
const RULE_REPAIR_LOOPS = Number(process.env.RULE_REPAIR_LOOPS || 2);
const PLAYWRIGHT_BROWSER_CHANNEL = process.env.PLAYWRIGHT_BROWSER_CHANNEL || "msedge";

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

const GENRE_PRESETS = [
  {
    id: "xiangqi",
    label: "Chinese Chess / Xiangqi",
    risk: "rule",
    keywords: ["中国象棋", "象棋", "xiangqi", "chinese chess"],
    instructions: [
      "This is a high-risk rules game. Correct board geometry, initial layout, legal moves, turn order, and human-vs-computer flow matter more than decoration.",
      "Expose window.__AI_GAME_META__ and, if possible, window.__AI_GAME_TEST__.getState() with board, turn, selected piece, winner, and legal moves.",
      "The player must control Red at the bottom; the computer must control Black at the top and move automatically after a legal Red move."
    ]
  },
  {
    id: "gomoku",
    label: "Gomoku / five-in-a-row",
    risk: "rule",
    keywords: ["五子棋", "gomoku", "five in a row", "five-in-a-row"],
    instructions: [
      "Use a grid board, one human side and one computer side by default.",
      "Implement legal placement, turn order, win detection for five in a row, draw detection, restart, invalid move feedback, and short move/capture/win sounds.",
      "The computer AI can be simple but must choose empty legal cells and should block immediate wins."
    ]
  },
  {
    id: "sokoban",
    label: "Sokoban",
    risk: "puzzle",
    keywords: ["推箱子", "sokoban", "箱子"],
    instructions: [
      "Levels must be solvable and beginner-friendly. Provide at least three levels, undo, restart, clear goals, and invalid push feedback.",
      "Do not place boxes in dead corners unless that square is a goal. Do not place goals behind unreachable walls.",
      "Expose simple test hooks if possible: reset(), step(action), getState()."
    ]
  },
  {
    id: "snake",
    label: "Snake",
    risk: "arcade",
    keywords: ["贪吃蛇", "snake"],
    instructions: [
      "Use a slow initial tick, large readable cells, pause/restart, clear score, and gentle difficulty growth.",
      "Avoid instant death on start. Include eat, turn/step, crash, restart, and mute sounds."
    ]
  },
  {
    id: "shooter",
    label: "Shooter",
    risk: "action",
    keywords: ["射击", "飞机", "太空", "shoot", "shooter", "space", "bullet"],
    instructions: [
      "Implement player movement, shooting, enemies, collisions, score, lives or health, restart, and gradual enemy pressure.",
      "Include shoot, hit, explosion, damage, collect/power-up, win/loss sounds."
    ]
  },
  {
    id: "platformer",
    label: "Platformer",
    risk: "action",
    keywords: ["平台跳跃", "横版", "跳跃", "platform", "platformer", "jump"],
    instructions: [
      "Implement gravity, jump, platforms, hazards or enemies, goal, checkpoints or restart, and readable collision feedback.",
      "Include jump, land, collect, hurt, checkpoint, finish sounds."
    ]
  },
  {
    id: "maze",
    label: "Maze",
    risk: "puzzle",
    keywords: ["迷宫", "maze", "逃脱"],
    instructions: [
      "Generate reachable start and exit positions. Include movement, collision with walls, goal detection, restart, and optional timer.",
      "Include move, bump, key/collect, exit, win/loss sounds."
    ]
  },
  {
    id: "cards",
    label: "Cards",
    risk: "rule",
    keywords: ["纸牌", "扑克牌", "扑克", "card", "cards", "poker", "solitaire"],
    instructions: [
      "Implement the actual core card rules, legal moves, turn/order handling, clear status, restart, and computer opponent when competitive.",
      "Include deal, select, move, invalid, capture/score, win/loss sounds."
    ]
  },
  {
    id: "matching",
    label: "Matching / tile elimination",
    risk: "puzzle",
    keywords: ["连连看", "消消乐", "消除", "三消", "配对", "动物消除", "match-3", "match 3", "matching", "tile matching", "link-link", "link game", "eliminate"],
    instructions: [
      "Use a real 2D board state array as the source of truth; every rendered tile must correspond to the current board value.",
      "For Lianliankan/link-link games, only remove two identical tiles when a clear path with at most two turns exists; show brief selection/path feedback.",
      "After a valid match, immediately update the board data, clear or remove the matched cells, clear the selection, update score/moves, and redraw the board. Never display success while leaving the board unchanged.",
      "If the design includes falling pieces, run a gravity/drop step after removal, compact each affected column, then refill empty cells with new tiles; animate or visibly show the board changing.",
      "If the design does not use gravity, the removed cells must still remain visibly empty and become usable path space for later matches.",
      "Expose window.__AI_GAME_TEST__ with getState() returning the board and, when practical, a selectCell(row,col) or step(action) helper."
    ]
  },
  {
    id: "arcade",
    label: "Arcade",
    risk: "arcade",
    keywords: ["打砖块", "躲避", "接球", "breakout", "arcade", "dodge"],
    instructions: [
      "Implement immediate playable controls, scoring, difficulty growth, loss/win condition, restart, and visible motion feedback.",
      "Include move, hit, collect, power-up, level clear, game over sounds."
    ]
  }
];

const generatorInstructions = `
你是一个“单文件浏览器小游戏生成器”。你的唯一任务是生成完整、可直接保存为 index.html 并在浏览器运行的小游戏。

硬性要求：
- 只输出完整 HTML 文档，不要 Markdown 代码围栏，不要解释，不要额外文本。
- 必须包含 <!doctype html>、<html>、<head>、<style>、<body> 和 <script>。
- 使用纯 HTML/CSS/JavaScript，不使用外部库，不加载外部资源，不依赖网络。
- 使用 <canvas> 或 DOM/CSS 实现游戏画面，游戏循环优先使用 requestAnimationFrame。
- 游戏必须有完整玩法闭环：玩家控制、核心规则、障碍或敌人、计分/HUD、胜负条件、重新开始按钮。
- 视觉风格要清晰、可爱、2D、颜色鲜明；动画反馈要可见。
- 每个游戏都必须有符合玩法的声音反馈，并提供静音开关；声音只能用内嵌 Web Audio API 合成，不能加载外部音频文件。
- 代码结构要清晰，便于继续修改。
- 键盘操作要阻止页面滚动；游戏结束或胜利后必须能重新开始。
- 生成的游戏会在 iframe Blob URL 预览中运行；不要使用 import、export、type="module"、fetch、localStorage、sessionStorage、Web Worker、外链字体或外链图片。
- 所有初始化代码必须等待 DOM 可用或放在 body 末尾；如果使用 canvas，必须设置明确 width/height，并在第一帧立刻绘制非空画面。
- 不要引用不存在的 DOM id、图片、音频或资源；不要让任何启动异常导致白屏。
- body 中必须有可见的游戏标题、HUD 或开始界面作为兜底，即使 canvas 绘制失败也不能是纯白空页面。
- 如果生成推箱子、迷宫、解谜或关卡制益智游戏，所有关卡必须可解；不要把目标点放在只能从墙内侧推动的位置；关卡数据旁要用简短注释写一条示例解法或设计意图。

输出内容必须是最终 HTML，不要出现“下面是代码”等说明。
`.trim();

const soundInstructions = `
Audio requirements:
- Every generated game must include suitable sound effects for its genre, implemented with the Web Audio API only. Do not use external audio files, base64 audio blobs, imports, fetch, or network assets.
- Create a small guarded audio manager, for example: lazy AudioContext creation, master volume, muted flag, and playSound(name). If Web Audio is unavailable, the game must keep working silently.
- Because browsers block autoplay, unlock or initialize audio only after the first user gesture: click, keydown, touchstart, Start button, or first move. Do not try to autoplay on page load.
- Add a visible sound/mute control in the HUD or menu. A compact button is enough; keep the game playable even when muted.
- Map sounds to the actual game verbs:
  - Arcade/action: shoot, hit, explosion, collect, power-up, damage, level clear, game over.
  - Puzzle/grid games: move, push, undo, invalid move, goal reached, level solved.
  - Snake: turn or step softly, eat, speed-up, crash, restart.
  - Board/card/rule games: piece select, legal move, capture, invalid move, check/warning, AI move, win/loss.
  - Platform/racing: jump, land, boost, collision, checkpoint, finish.
- Keep sounds short and pleasant. Use oscillators, gain envelopes, filters, and noise bursts; avoid harsh continuous tones.
- Audio code must be self-contained, readable, and should not throw errors inside iframe or Blob URL previews.
`.trim();

const difficultyInstructions = `
Difficulty rules:
- Default to beginner-friendly gameplay unless the user explicitly asks for hard mode.
- For Snake games, use a slow initial tick, large readable grid cells, gentle speed growth, pause/restart controls, and optional Easy/Normal/Hard difficulty selection.
- For reaction games, shooters, dodgers, and arcade games, begin slowly and increase difficulty gradually.
- Avoid failure in the first few seconds unless the player makes a clear mistake.
- Do not start physics, timers, falling objects, enemy attacks, or loss checks until the player intentionally starts the round with a click, tap, key press, or Start button.
- Arcade skill games such as juggling, keep-up, bouncing, catching, dodging, or rhythm games must include a ready state and at least 1.5 seconds of grace after the first input; never show Game Over with score 0 before meaningful player action.
- Initial object positions must be forgiving: balls, hazards, enemies, or failure lines should not overlap or begin within an instant-loss zone, and collision/loss thresholds should be visibly fair.
- When modifying an existing game because it is too hard, reduce speed, soften acceleration, add difficulty controls, and keep the original visual style.
`.trim();

const firstViewportLayoutInstructions = `
First-viewport layout rules:
- The initial viewport must show the actual playable surface or primary controls, not a tall empty intro/result/status/output area.
- Do not place the main game card, canvas, board, sliders, start button, or answer controls below a large blank block.
- Keep result, log, status, and output panels compact until they contain meaningful content; hide or collapse an empty result card before the game ends.
- Avoid CSS min-height or height values on status/result/output panels that consume more than 35vh unless that panel is the active playfield.
- The player should not need to scroll on desktop or mobile preview sizes to reach the first playable action.
- When a result card is shown, keep replay and copy/share actions close to the result.
`.trim();

const viralGameInstructions = `
Viral game workshop rules:
- Treat the game as a small shareable internet toy, not just a playable demo.
- The first screen must show a one-sentence challenge/hook that is understandable in under 3 seconds.
- The core interaction must start immediately: one click, one key, one drag, one guess, or one obvious button.
- The end state or result state must include a screenshot-friendly result card with a measurable result: score, percent, time, streak, discoveries, accuracy, rank, title, or funny verdict.
- Include an obvious replay/restart action near the result card.
- Include an obvious copy/share button. It should copy a compact share text when Clipboard API works and fall back to selecting text, a textarea, or prompt-style manual copy when clipboard is unavailable.
- When the player completes, fails, wins, loses, or reaches a meaningful result, send that result to the parent workshop with exactly this shape:
  parent.postMessage({
    source: "ai-game-workshop",
    type: "result",
    title: "Game title",
    metric: "Score or verdict",
    shareText: "Short shareable sentence"
  }, "*");
- Do not wait for social networks or external services. The share loop must be fully offline and single-file.
- Add window.__AI_GAME_META__ with at least: title, hook, genre, controls, winCondition, loseCondition, shareTemplate, sounds.
`.trim();

const rulesGameInstructions = `
Rule-fidelity rules for established games:
- If the requested game is a well-known rules game, prioritize rule correctness over decorative visuals.
- Do not invent simplified rules unless the user explicitly asks for a simplified version.
- The game must be playable, not just a board renderer. Include turn handling, legal move validation, capture/win detection, restart, and clear status text.
- For competitive board games, default to player-vs-computer play with a simple legal-move AI opponent. Also provide an optional two-player mode only if it is easy to add.
- Show selectable pieces/cells, legal move hints, invalid move feedback, current side to move, and winner/draw state.
- For Chinese Chess / Xiangqi / 中国象棋 specifically:
  - Use a 9-column by 10-row board played on intersections, with river and two 3x3 palaces.
  - Initial setup must be exact: Red bottom and Black top, 16 pieces each.
  - Use exact coordinate setup with columns 0-8 and rows 0-9:
    Black: row 0 = 車 馬 象 士 將 士 象 馬 車; cannons at (1,2) and (7,2); pawns at (0,3),(2,3),(4,3),(6,3),(8,3).
    Red: row 9 = 車 馬 相 仕 帥 仕 相 馬 車; cannons at (1,7) and (7,7); soldiers at (0,6),(2,6),(4,6),(6,6),(8,6).
    Never place pawns/soldiers as a full row, and never place cannons in the center file.
  - Piece names must be correct: red 帅仕相车马炮兵, black 将士象车马炮卒.
  - Implement legal moves: rook straight lines, horse with blocked leg, elephant with blocked eye and cannot cross river, advisor diagonal inside palace, general inside palace and flying-general rule, cannon moves/captures with exactly one screen, pawn forward and sideways only after crossing river.
  - Prevent illegal self-check and detect check/checkmate or at least winner by capturing/checkmating the general.
  - Default mode must be human Red vs computer Black. Red is controlled by the player. Black AI must choose from legal moves, preferably prioritizing captures, escaping check, checking the red general, and then random legal moves.
  - Provide undo, restart, clear move/error messages, current side indicator, and optional mode switch for human-vs-human if practical.
  - Add Xiangqi-specific sounds: select, legal move, capture, invalid move, check/warning, AI move, win/loss, plus a mute button.
  - If a full checkmate search is too complex, still enforce legal piece movement and end the game when a general is captured, while clearly showing current turn.
- For International Chess, enforce normal legal piece movement, turn order, captures, king safety, check/checkmate or king-capture fallback, restart, and default human-vs-computer play.
- For Go, Gomoku, Checkers, Reversi, Connect Four, Sudoku, Mahjong-like, and card games, implement their core rules and win/draw checks instead of making a static visual mockup; default to human-vs-computer when the game is naturally competitive and an AI can be approximated with legal moves.
`.trim();

const xiangqiExactSpec = `
Xiangqi hard requirements:
- Treat the board as 9 files x 10 ranks using intersection coordinates {x:0..8,y:0..9}.
- The exact initial data must be equivalent to this array:
  [
    ["bR","bH","bE","bA","bG","bA","bE","bH","bR"],
    [null,null,null,null,null,null,null,null,null],
    [null,"bC",null,null,null,null,null,"bC",null],
    ["bP",null,"bP",null,"bP",null,"bP",null,"bP"],
    [null,null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null,null],
    ["rP",null,"rP",null,"rP",null,"rP",null,"rP"],
    [null,"rC",null,null,null,null,null,"rC",null],
    [null,null,null,null,null,null,null,null,null],
    ["rR","rH","rE","rA","rG","rA","rE","rH","rR"]
  ]
- Mapping: R=rook/车, H=horse/马, E=elephant/相象, A=advisor/仕士, G=general/帅将, C=cannon/炮, P=pawn/兵卒.
- Red pieces are controlled by the human player and start at y=9/bottom. Black pieces are controlled by the computer AI and start at y=0/top.
- Never create a full row of pawns or soldiers. There are exactly five black pawns and five red soldiers.
- Never place cannons at center file x=4. Cannons are only at x=1 and x=7 on y=2/y=7.
- After every legal red move, black AI must automatically make one legal move after a short delay.
- The AI can be simple, but it must only choose legal moves. Priority: capture red general, escape check, capture high-value piece, give check, otherwise random legal move.
- Include a self-check function or at minimum prevent generals from facing each other with no pieces between them.
`.trim();

const ruleAuditInstructions = `
Rule-game audit/fix pass:
- You are reviewing generated single-file HTML for a rules-heavy game.
- If the game is Xiangqi/Chinese Chess, verify the exact coordinate setup, piece counts, legal move functions, and human-red-vs-computer-black turn loop.
- Verify that the game includes suitable Web Audio API sound effects and a mute control, without external audio files.
- If any rule/layout/AI requirement is missing, rewrite the HTML to fix it.
- Return only the corrected complete HTML. No Markdown. No explanation.
`.trim();

function buildGeneratePrompt(gameName, extraRequirements) {
  return `
用户输入的游戏名称：${gameName}

请把这个一句话需求自动扩展成完整小游戏需求并实现。

默认规格：
- 生成一个可直接在浏览器运行的“${gameName}”网页游戏。
- 使用完整单文件 HTML 实现。
- 用一个首屏可见的一句话挑战讲清楚玩法，例如“画一个最圆的圆”“撑过最多离谱密码规则”“10 题判断真假 Logo”。
- 包含完整玩家控制、核心玩法规则、关卡或难度递增、计分/HUD、胜负条件、重新开始按钮和清晰可爱的 2D 动画效果。
- 必须有结果页或结束态：展示可量化结果、称号或吐槽 verdict，并设计成适合截图的结果卡。
- 必须有复制/分享结果按钮和重玩按钮；复制失败时提供手动复制兜底。
- 必须在玩家完成、失败、胜利、结算或生成重要结果时调用 parent.postMessage({ source: "ai-game-workshop", type: "result", title, metric, shareText }, "*")，把结果回传给父页面。
- 必须给游戏配上符合玩法的内嵌音效，例如移动、点击、收集、攻击、爆炸、吃子、胜利、失败等；使用 Web Audio API 合成，并提供静音按钮。
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
- 保留或补齐爆款小游戏闭环：首屏一句话挑战、可量化结果卡、复制/分享按钮、重玩按钮，以及 ai-game-workshop result postMessage 回传。
- 如果当前游戏缺少声音，或用户要求增加声音，必须加入符合玩法的 Web Audio API 内嵌音效和静音按钮，不得引用外部音频资源。
- 如果用户指出棋类/牌类/传统规则游戏规则不对或布局不对，必须优先重建正确规则、初始数据、合法行动和人机对战逻辑，不要只调整视觉。
- 如果是连连看、消消乐、三消、配对消除或动物消除游戏，合法匹配后必须更新内部 board 数据并重绘棋盘；被消除格子要清空/移除；需要下落玩法时必须执行重力下落和补新块；不能只显示“消除成功”但棋盘不变。
- 修复后必须能在 iframe Blob URL 预览中直接显示首屏画面，避免白屏。
- 只输出修改后的完整 HTML，不要 Markdown，不要解释。

当前 HTML：
<<<HTML_START
${html}
HTML_END>>>
`.trim();
}

function buildSystemInstructions(ruleHeavy, intent) {
  const parts = [generatorInstructions, soundInstructions, difficultyInstructions, firstViewportLayoutInstructions, viralGameInstructions, rulesGameInstructions];
  if (intent) {
    parts.push(buildGenreInstructions(intent));
  }
  if (ruleHeavy) {
    parts.push(xiangqiExactSpec);
    parts.push("For rules-heavy games, use deeper reasoning internally before writing code. Verify the state model, initial data, legal actions, AI turn loop, and win conditions before final output.");
  }
  return parts.join("\n\n");
}

function isRuleHeavyRequest(text) {
  return analyzeGameIntent(text).ruleHeavy;
}

function analyzeGameIntent(text) {
  const value = String(text || "").toLowerCase();
  let best = GENRE_PRESETS[GENRE_PRESETS.length - 1];
  let bestScore = 0;

  for (const preset of GENRE_PRESETS) {
    const score = preset.keywords.reduce((sum, keyword) => {
      return value.includes(keyword.toLowerCase()) ? sum + Math.max(1, keyword.length) : sum;
    }, 0);
    if (score > bestScore) {
      best = preset;
      bestScore = score;
    }
  }

  const extraRuleKeywords = [
    "国际象棋", "chess", "围棋", "go game", "黑白棋", "reversi", "othello",
    "跳棋", "checkers", "四子棋", "connect four", "数独", "sudoku",
    "麻将", "mahjong", "军棋", "斗兽棋"
  ];
  const ruleHeavy = best.risk === "rule" || extraRuleKeywords.some((keyword) => value.includes(keyword.toLowerCase()));

  return {
    genre: best.id,
    label: best.label,
    risk: best.risk,
    ruleHeavy,
    highRisk: ruleHeavy || best.risk === "puzzle",
    preset: best,
    maxRepairLoops: ruleHeavy ? RULE_REPAIR_LOOPS : NORMAL_REPAIR_LOOPS
  };
}

function buildGenreInstructions(intent) {
  const preset = intent.preset || GENRE_PRESETS.find((item) => item.id === intent.genre);
  const instructions = preset ? preset.instructions.join("\n- ") : "Implement a complete, playable browser game loop.";
  return `
Genre routing:
- Detected genre: ${intent.label || intent.genre}.
- These genre-specific requirements are hidden quality gates; satisfy them in the returned HTML.
- ${instructions}
- Add window.__AI_GAME_META__ with at least: title, hook, genre, controls, winCondition, loseCondition, shareTemplate, sounds.
- When practical, add window.__AI_GAME_TEST__ with reset(), step(action), and getState() so the local generator can run smoke tests.
`.trim();
}

function createDefaultHook(title, detail) {
  const text = `${title || ""} ${detail || ""}`.toLowerCase();
  if (/圆|circle/.test(text)) return "画一个尽可能完美的圆，看系统给你多少分。";
  if (/密码|password/.test(text)) return "写一个满足越来越离谱规则的密码，看看你能撑到第几条。";
  if (/真假|logo|fake|ai or not|判断/.test(text)) return "在真假之间快速下注，最后晒出你的判断力。";
  if (/颜色|color/.test(text)) return "看一眼颜色，再凭记忆把它还原出来。";
  if (/组合|craft|合成|词/.test(text)) return "把两个东西组合起来，看看会长出什么离谱结果。";
  if (/象棋|棋|chess|gomoku|五子/.test(text)) return "用一局清晰可玩的规则挑战，证明你的策略还在线。";
  return `挑战「${title || "这个小游戏"}」，拿到一个值得截图分享的结果。`;
}

function createDefaultViralTags(title, detail) {
  const text = `${title || ""} ${detail || ""}`.toLowerCase();
  if (/圆|circle/.test(text)) return ["手感挑战", "百分制", "结果卡"];
  if (/密码|password/.test(text)) return ["规则递进", "吐槽感", "可重玩"];
  if (/真假|logo|fake|判断/.test(text)) return ["真假判断", "正确率", "称号"];
  if (/颜色|color/.test(text)) return ["记忆挑战", "色差评分", "截图友好"];
  if (/组合|craft|合成|词/.test(text)) return ["无限组合", "发现数", "离谱结果"];
  return ["一句话挑战", "结果可晒", "可重玩"];
}

function createDefaultShareText(title, detail) {
  const hook = createDefaultHook(title, detail);
  return `我刚生成了「${title}」：${hook}。来试试你能拿到什么结果。`;
}

async function auditRuleGameHtml(html, context) {
  return requestGameHtml([
    { role: "system", content: `${generatorInstructions}\n\n${soundInstructions}\n\n${difficultyInstructions}\n\n${firstViewportLayoutInstructions}\n\n${viralGameInstructions}\n\n${rulesGameInstructions}\n\n${xiangqiExactSpec}\n\n${ruleAuditInstructions}` },
    {
      role: "user",
      content: [
        "Context:",
        context,
        "",
        "Review and fix this generated HTML. Return only complete corrected HTML.",
        "<<<HTML_START",
        html,
        "HTML_END>>>"
      ].join("\n")
    }
  ], { ruleHeavy: true, audit: true });
}

const server = http.createServer(async (req, res) => {
  try {
    req.setTimeout(SERVER_TIMEOUT_MS);
    res.setTimeout(SERVER_TIMEOUT_MS, () => {
      const error = new Error("Server response timeout while waiting for AI generation.");
      logError(error);
      sendJson(res, {
        error: "AI 生成时间过长，本地连接已超时。请稍后重试，或使用更简单的补充需求。",
        detail: `当前服务端总超时：${Math.round(SERVER_TIMEOUT_MS / 1000)} 秒`
      }, 504);
    });

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
        ruleModel: DEEPSEEK_RULE_MODEL,
        thinking: DEEPSEEK_THINKING,
        reasoningEffort: DEEPSEEK_REASONING_EFFORT,
        deepseekTimeoutMs: DEEPSEEK_TIMEOUT_MS,
        serverTimeoutMs: SERVER_TIMEOUT_MS,
        browserQa: getPlaywrightState().available && ENABLE_BROWSER_QA,
        browserQaAvailable: getPlaywrightState().available,
        playtestTimeoutMs: PLAYTEST_TIMEOUT_MS,
        baseUrl: DEEPSEEK_BASE_URL,
        hasKey: Boolean(process.env.DEEPSEEK_API_KEY)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/thumbnail") {
      const body = await readJson(req, MAX_THUMBNAIL_BODY_BYTES);
      const htmlInput = normalizeHtmlInput(body.html, MAX_THUMBNAIL_BODY_BYTES);
      const thumbnail = await captureHtmlThumbnail(htmlInput);
      return sendJson(res, { thumbnail });
    }

    if (req.method === "POST" && url.pathname === "/api/generate") {
      const body = await readJson(req);
      const gameName = normalizeShortText(body.gameName, "gameName", 80);
      const extraRequirements = normalizeOptionalText(body.extraRequirements, 1200);
      const intent = analyzeGameIntent(`${gameName}\n${extraRequirements}`);

      const finalResult = await runQualityPipeline({
        action: "generate",
        title: gameName,
        contextText: `${gameName}\n${extraRequirements}`,
        intent,
        createInitial: () => requestGameHtml([
          { role: "system", content: buildSystemInstructions(intent.ruleHeavy, intent) },
          { role: "user", content: buildGeneratePrompt(gameName, extraRequirements) }
        ], { ruleHeavy: intent.ruleHeavy })
      });

      return sendJson(res, {
        html: finalResult.html,
        model: finalResult.model,
        audited: finalResult.audited,
        repaired: finalResult.repairLoops > 0,
        qualityPassed: finalResult.qualityPassed,
        viralChecked: true,
        intent: {
          genre: intent.genre,
          label: intent.label,
          ruleHeavy: intent.ruleHeavy
        },
        hook: createDefaultHook(gameName, extraRequirements),
        viralTags: createDefaultViralTags(gameName, extraRequirements),
        defaultShareText: createDefaultShareText(gameName, extraRequirements)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/modify") {
      const body = await readJson(req);
      const title = normalizeShortText(body.title, "title", 120);
      const instruction = normalizeShortText(body.instruction, "instruction", 1200);
      const htmlInput = normalizeHtmlInput(body.html);
      const intent = analyzeGameIntent(`${title}\n${instruction}\n${htmlInput.slice(0, 2000)}`);

      const finalResult = await runQualityPipeline({
        action: "modify",
        title,
        contextText: `${title}\n${instruction}`,
        intent,
        createInitial: () => requestGameHtml([
          { role: "system", content: buildSystemInstructions(intent.ruleHeavy, intent) },
          { role: "user", content: buildModifyPrompt(title, htmlInput, instruction) }
        ], { ruleHeavy: intent.ruleHeavy })
      });

      return sendJson(res, {
        html: finalResult.html,
        model: finalResult.model,
        audited: finalResult.audited,
        repaired: finalResult.repairLoops > 0,
        qualityPassed: finalResult.qualityPassed,
        viralChecked: true,
        intent: {
          genre: intent.genre,
          label: intent.label,
          ruleHeavy: intent.ruleHeavy
        },
        hook: createDefaultHook(title, instruction),
        viralTags: createDefaultViralTags(title, instruction),
        defaultShareText: createDefaultShareText(title, instruction)
      });
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

server.requestTimeout = SERVER_TIMEOUT_MS;
server.headersTimeout = Math.min(SERVER_TIMEOUT_MS, 600000);
server.timeout = SERVER_TIMEOUT_MS;

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

async function runQualityPipeline({ action, title, contextText, intent, createInitial }) {
  let result = await createInitial();
  let html = result.html;
  let model = result.model;
  let report = null;
  let repairLoops = 0;
  let forceRuleAudit = Boolean(intent.ruleHeavy);

  while (true) {
    report = await evaluateGeneratedGameHtml(html, intent, { forceRuleAudit });
    recordQualityEvent({
      action,
      title,
      genre: intent.genre,
      ruleHeavy: intent.ruleHeavy,
      attempt: repairLoops,
      model,
      passed: report.passed,
      shouldRepair: report.shouldRepair,
      issues: report.issues.map((issue) => ({
        severity: issue.severity,
        code: issue.code,
        message: issue.message
      }))
    });

    if (!report.shouldRepair) {
      return {
        html,
        model,
        audited: intent.ruleHeavy || repairLoops > 0,
        repairLoops,
        qualityPassed: report.passed
      };
    }

    if (repairLoops >= intent.maxRepairLoops) {
      const blockers = report.issues.filter((issue) => issue.severity === "blocker");
      if (blockers.length) {
        const error = new Error("AI 生成结果没有通过后台质量检查，已自动修复但仍未达标。请换一个更具体的游戏描述再试。");
        error.statusCode = 502;
        error.publicDetail = blockers.map((issue) => issue.message).join("；");
        throw error;
      }
      return {
        html,
        model,
        audited: true,
        repairLoops,
        qualityPassed: false
      };
    }

    repairLoops += 1;
    forceRuleAudit = false;
    const repaired = await repairGeneratedHtml({
      title,
      html,
      contextText,
      intent,
      report,
      attempt: repairLoops
    });
    html = repaired.html;
    model = repaired.model;
  }
}

async function repairGeneratedHtml({ title, html, contextText, intent, report, attempt }) {
  const issueLines = report.issues.length
    ? report.issues.map((issue) => `- [${issue.severity}] ${issue.code}: ${issue.message}`).join("\n")
    : "- No explicit issue lines were captured, but the hidden quality gate requested a repair.";

  const browserSummary = report.browser && report.browser.skipped
    ? `Browser playtest skipped: ${report.browser.reason || "unknown"}`
    : "Browser playtest ran and its findings are listed above.";

  return requestGameHtml([
    {
      role: "system",
      content: [
        buildSystemInstructions(intent.ruleHeavy, intent),
        "",
        "You are repairing a generated single-file HTML game after hidden local QA.",
        "Return only the corrected complete HTML. Do not explain.",
        "Preserve the requested game and visual direction, but prioritize bootability, playability, correct rules, restart, controls, and Web Audio mute support.",
        "If the first viewport is mostly an empty status/result/output block and the playable game is below the fold, compact or hide that passive block and move the playable surface and primary controls into the first viewport.",
        "For matching/elimination games, fix the state transition itself: after a valid match, mutate the board array, clear selections, redraw all tiles, update score/moves, and run gravity/refill when the game promises falling pieces. Do not merely change the success message."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Game title: ${title}`,
        `Original request/context: ${contextText}`,
        `Detected genre: ${intent.label}`,
        `Repair attempt: ${attempt}`,
        "",
        "Hidden QA findings to fix before returning the final game:",
        issueLines,
        browserSummary,
        "",
        "Current HTML:",
        "<<<HTML_START",
        html,
        "HTML_END>>>"
      ].join("\n")
    }
  ], { ruleHeavy: intent.ruleHeavy });
}

async function evaluateGeneratedGameHtml(html, intent, options = {}) {
  const staticIssues = runStaticQualityChecks(html, intent, options);
  const browser = await runBrowserPlaytest(html, intent);
  const issues = staticIssues.concat(browser.issues || []);
  const shouldRepair = issues.some((issue) => issue.severity === "blocker" || issue.severity === "major");
  const passed = !issues.some((issue) => issue.severity === "blocker");

  return {
    passed,
    shouldRepair,
    issues,
    browser
  };
}

function runStaticQualityChecks(html, intent, options = {}) {
  const issues = [];
  const lower = html.toLowerCase();

  addIssueIf(issues, !lower.includes("<html") || !lower.includes("</html>"), "blocker", "html-shell", "缺少完整 HTML 根结构。");
  addIssueIf(issues, !lower.includes("<style"), "blocker", "missing-style", "缺少内嵌 style。");
  addIssueIf(issues, !lower.includes("<script"), "blocker", "missing-script", "缺少内嵌 script。");
  addIssueIf(issues, /<script\b[^>]*\bsrc\s*=/i.test(html), "major", "external-script", "包含外部 script，单文件游戏不能依赖外部脚本。");
  addIssueIf(issues, /<link\b[^>]*\bhref\s*=/i.test(html), "major", "external-link", "包含外部 link/href，单文件游戏不能依赖外部样式或字体。");
  addIssueIf(issues, /<img\b[^>]*\bsrc\s*=\s*["']https?:/i.test(html), "major", "external-image", "包含外链图片，离线下载后可能失效。");
  addIssueIf(issues, /\b(fetch|XMLHttpRequest|import\s*\(|new\s+Worker|localStorage|sessionStorage)\b/.test(html), "major", "blocked-api", "包含 fetch、存储、Worker 或动态 import 等预览中禁用的能力。");

  const scripts = extractInlineScripts(html);
  scripts.forEach((script, index) => {
    try {
      new vm.Script(script, { filename: `generated-game-script-${index + 1}.js` });
    } catch (error) {
      issues.push({
        severity: "blocker",
        code: "script-syntax",
        message: `第 ${index + 1} 个 script 存在语法错误：${error.message}`
      });
    }
  });

  const visibleText = stripTags(html).replace(/\s+/g, "");
  addIssueIf(issues, visibleText.length < 6, "major", "weak-visible-text", "HTML 中可见文字过少，首屏可能像白屏。");
  addIssueIf(issues, !/(restart|reset|again|重新|重开|再来|开始|start)/i.test(html), "major", "missing-restart", "没有明显的开始/重开入口。");
  addIssueIf(issues, !/(AudioContext|webkitAudioContext)/.test(html), "major", "missing-web-audio", "没有发现 Web Audio API 音效实现。");
  addIssueIf(issues, !/(mute|sound|audio|volume|静音|声音|音效)/i.test(html), "major", "missing-mute-control", "没有明显的声音/静音控制。");
  addIssueIf(issues, !/(challenge|hook|目标|挑战|玩法|试试|规则)/i.test(html), "major", "missing-hook", "缺少首屏一句话挑战或玩法钩子。");
  addIssueIf(issues, !/(share|copy|clipboard|复制|分享|晒出|炫耀)/i.test(html), "major", "missing-share-control", "缺少复制/分享结果入口。");
  addIssueIf(issues, !/(result|score|rank|title|verdict|accuracy|streak|time|percent|结果|分数|得分|称号|正确率|用时|百分)/i.test(html), "major", "missing-result-card", "缺少可量化结果卡或结算信息。");
  addIssueIf(issues, !/parent\.postMessage\s*\(/.test(html) || !/ai-game-workshop/.test(html) || !/["']?type["']?\s*:\s*["']result["']/.test(html), "major", "missing-result-postmessage", "缺少向父页面回传结果的 ai-game-workshop postMessage。");
  addIssueIf(issues, !/(shareText|metric)/.test(html), "major", "missing-share-payload", "结果回传应包含 metric 和 shareText。");

  if (intent.genre === "xiangqi") {
    addIssueIf(issues, !/(9|nine).{0,40}(10|ten)|x\s*[:<=>].{0,10}8|y\s*[:<=>].{0,10}9/i.test(html), "major", "xiangqi-board-size", "中国象棋应使用 9x10 交叉点棋盘。");
    addIssueIf(issues, !/(rR|rG|帅|帥).{0,300}(bR|bG|将|將)|(bR|bG|将|將).{0,300}(rR|rG|帅|帥)/s.test(html), "major", "xiangqi-piece-data", "没有发现可信的红黑双方初始棋子数据。");
    addIssueIf(issues, !/(AI|computer|电脑|机器|blackAI|makeAIMove|aiMove)/i.test(html), "major", "xiangqi-ai", "中国象棋必须默认人机对战，并让黑方电脑自动走棋。");
  }

  if (intent.genre === "sokoban") {
    addIssueIf(issues, !/(undo|撤销|ctrl\+z|history)/i.test(html), "major", "sokoban-undo", "推箱子应支持撤销。");
    addIssueIf(issues, !/(levels|level|关卡)/i.test(html), "major", "sokoban-levels", "推箱子应包含多个清晰可解关卡。");
  }

  if (intent.genre === "matching") {
    addIssueIf(issues, !/(board|grid|tiles|cells|matrix|棋盘|格子)/i.test(html), "major", "matching-state-model", "消除/配对游戏需要明确的棋盘状态数据。");
    addIssueIf(issues, !/(renderBoard|drawBoard|redraw|renderGrid|updateBoard|drawTiles|renderTiles|draw\s*\(|render\s*\()/i.test(html), "major", "matching-redraw", "消除/配对游戏需要在状态变化后重绘棋盘。");
    addIssueIf(issues, !/(removeTile|clearTile|clearMatch|matched|removed|cleared|splice|delete|null|empty|消除|清空|移除)/i.test(html), "major", "matching-remove-state", "合法匹配后必须清空或移除对应棋盘格。");
    addIssueIf(issues, /(下落|掉落|补新|补充|gravity|drop|fall|refill|collapse)/i.test(html)
      && !/(applyGravity|dropTiles|fallTiles|collapseColumns|refillBoard|refillTiles|fillEmpty|fillHoles|compactColumns)/i.test(html), "major", "matching-gravity-refill", "承诺下落/补块的消除游戏必须实现重力下落和补新块。");
  }

  if (options.forceRuleAudit) {
    issues.push({
      severity: "major",
      code: "rule-audit-required",
      message: "规则密集游戏需要至少一轮隐藏规则审查，确认布局、合法行动、人机对战和胜负判定。"
    });
  }

  return dedupeIssues(issues);
}

async function runBrowserPlaytest(html, intent) {
  if (!ENABLE_BROWSER_QA) {
    return { skipped: true, reason: "browser QA disabled", issues: [] };
  }

  const state = getPlaywrightState();
  if (!state.available) {
    return {
      skipped: true,
      reason: state.reason,
      issues: [{
        severity: "minor",
        code: "playwright-unavailable",
        message: "Playwright 未安装或不可用，已跳过浏览器自动试玩。"
      }]
    };
  }

  let browser = null;
  try {
    browser = await launchPlaywrightBrowser(state.playwright);
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
    const consoleErrors = [];
    const pageErrors = [];

    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/*", (route) => {
      const request = route.request();
      if (request.isNavigationRequest() || request.url().startsWith("data:") || request.url().startsWith("about:")) {
        return route.continue();
      }
      return route.abort();
    });

    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: PLAYTEST_TIMEOUT_MS });
    await page.waitForTimeout(900);
    const before = await collectPageDiagnostics(page);

    await page.keyboard.press("ArrowRight").catch(() => {});
    await page.keyboard.press("ArrowDown").catch(() => {});
    await page.keyboard.press("Space").catch(() => {});
    await page.waitForTimeout(450);
    const after = await collectPageDiagnostics(page);

    const issues = [];
    addIssueIf(issues, pageErrors.length > 0, "blocker", "page-error", `试玩时脚本报错：${pageErrors.slice(0, 3).join(" | ")}`);
    addIssueIf(issues, consoleErrors.length > 0, "major", "console-error", `试玩时 console error：${consoleErrors.slice(0, 3).join(" | ")}`);
    addIssueIf(issues, before.looksBlank, "blocker", "blank-screen", `首屏疑似白屏：${before.blankReason}`);
    addIssueIf(issues, before.visibleElementCount < 3 && !before.hasNonBlankCanvas, "major", "thin-first-screen", "首屏可见元素过少。");
    addIssueIf(issues, !before.hasRestartLikeControl, "major", "no-restart-control", "试玩页面没有发现开始/重开按钮或入口。");
    addIssueIf(issues, !before.hasSoundLikeControl, "major", "no-sound-control", "试玩页面没有发现声音/静音控制。");
    addIssueIf(issues, before.hasCanvas && !before.hasNonBlankCanvas, "blocker", "blank-canvas", "检测到 canvas，但首屏像素为空。");
    addIssueIf(issues, !before.hasCanvas && before.visibleElementCount < 6, "major", "weak-render-surface", "没有 canvas，且 DOM 游戏画面元素偏少。");
    addIssueIf(issues, before.firstViewportNeedsScrollToPlay, "major", "playfield-below-fold", "First viewport has no visible playable surface or primary controls; the game appears to be below a tall passive area.");
    addIssueIf(issues, before.largePassivePanelCount > 0, "major", "oversized-passive-panel", "First viewport contains an oversized passive result/status/output panel before the playable controls.");
    addIssueIf(issues, before.hasImmediateGameOver, "major", "instant-game-over", "Game reaches a loss/result state before meaningful player input; add a ready/start state, grace period, and fair initial positions.");

    const changed = before.visualSignature !== after.visualSignature || before.textSignature !== after.textSignature;
    addIssueIf(issues, !changed && intent.risk !== "rule", "minor", "input-no-visible-change", "按方向键和空格后画面没有明显变化，可能需要检查输入响应。");

    return {
      skipped: false,
      issues: dedupeIssues(issues),
      diagnostics: {
        before,
        after,
        consoleErrors: consoleErrors.slice(0, 5),
        pageErrors: pageErrors.slice(0, 5)
      }
    };
  } catch (error) {
    return {
      skipped: true,
      reason: error.message,
      issues: [{
        severity: "minor",
        code: "playtest-failed",
        message: `浏览器自动试玩未完成：${error.message}`
      }]
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function captureHtmlThumbnail(html) {
  const state = getPlaywrightState();
  if (!state.available) {
    const error = new Error("Playwright 不可用，无法生成游戏截图。");
    error.statusCode = 503;
    error.publicDetail = state.reason;
    throw error;
  }

  let browser = null;
  let page = null;
  try {
    browser = await getThumbnailBrowser(state.playwright);
    page = await browser.newPage({
      viewport: { width: 960, height: 540 },
      deviceScaleFactor: 1
    });
    await page.route("**/*", (route) => {
      const request = route.request();
      if (request.isNavigationRequest() || request.url().startsWith("data:") || request.url().startsWith("about:")) {
        return route.continue();
      }
      return route.abort();
    });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: PLAYTEST_TIMEOUT_MS });
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
      document.body.style.margin ||= "0";
      if (!document.body.style.background) {
        document.body.style.background = "#ffffff";
      }
    }).catch(() => {});
    const buffer = await page.screenshot({
      type: "jpeg",
      quality: 76,
      fullPage: false
    });
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

async function getThumbnailBrowser(playwright) {
  if (!getThumbnailBrowser.promise) {
    getThumbnailBrowser.promise = launchPlaywrightBrowser(playwright)
      .then((browser) => {
        browser.on("disconnected", () => {
          getThumbnailBrowser.promise = null;
        });
        return browser;
      })
      .catch((error) => {
        getThumbnailBrowser.promise = null;
        throw error;
      });
  }
  const browser = await getThumbnailBrowser.promise;
  if (typeof browser.isConnected === "function" && !browser.isConnected()) {
    getThumbnailBrowser.promise = null;
    return getThumbnailBrowser(playwright);
  }
  return browser;
}

async function launchPlaywrightBrowser(playwright) {
  const channels = uniqueModels([
    PLAYWRIGHT_BROWSER_CHANNEL,
    "msedge",
    "chrome"
  ]);
  const launches = channels
    .filter((channel) => channel && channel !== "bundled")
    .map((channel) => ({ headless: true, channel }));
  launches.push({ headless: true });

  let lastError = null;
  for (const options of launches) {
    try {
      return await playwright.chromium.launch(options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No Playwright browser launch option worked.");
}

async function collectPageDiagnostics(page) {
  return page.evaluate(() => {
    var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;

    function isInFirstViewport(rect, ratio) {
      var cutoff = viewportHeight * (ratio || 0.92);
      return rect && rect.right > 0 && rect.left < viewportWidth && rect.bottom > 0 && rect.top < cutoff;
    }

    function isVisible(element) {
      var rect = element.getBoundingClientRect();
      var style = window.getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0.01;
    }

    function canvasInfo(canvas) {
      var rect = canvas.getBoundingClientRect();
      var info = {
        width: canvas.width,
        height: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        visible: isVisible(canvas),
        inFirstViewport: isInFirstViewport(rect),
        nonBlank: false,
        signature: ""
      };
      try {
        var ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx || !canvas.width || !canvas.height) return info;
        var w = Math.min(canvas.width, 80);
        var h = Math.min(canvas.height, 80);
        var data = ctx.getImageData(0, 0, w, h).data;
        var sum = 0;
        var nonWhite = 0;
        for (var i = 0; i < data.length; i += 16) {
          var r = data[i] || 0;
          var g = data[i + 1] || 0;
          var b = data[i + 2] || 0;
          var a = data[i + 3] || 0;
          sum = (sum + r * 3 + g * 5 + b * 7 + a * 11) % 1000000007;
          if (a > 0 && (r < 245 || g < 245 || b < 245)) nonWhite++;
        }
        info.nonBlank = nonWhite > 4;
        info.signature = String(sum) + ":" + nonWhite;
      } catch (error) {
        info.signature = "unreadable";
      }
      return info;
    }

    var body = document.body;
    var text = body ? (body.innerText || "").trim() : "";
    var elements = body ? Array.from(body.querySelectorAll("*")) : [];
    var visibleElements = elements.filter(isVisible);
    var canvases = Array.from(document.querySelectorAll("canvas")).map(canvasInfo);
    var hasNonBlankCanvas = canvases.some(function(info) { return info.nonBlank; });
    var hasNonBlankCanvasInFirstViewport = canvases.some(function(info) { return info.nonBlank && info.inFirstViewport; });
    var interactiveElements = elements.filter(function(el) {
      var role = (el.getAttribute("role") || "").toLowerCase();
      var tag = el.tagName || "";
      return /^(button|a|input|select|textarea|summary)$/i.test(tag)
        || /^(button|link|slider|textbox|checkbox|radio|switch)$/i.test(role)
        || (el.tabIndex >= 0 && role !== "presentation");
    });
    var visibleInteractiveElements = interactiveElements.filter(isVisible);
    var interactiveInFirstViewport = visibleInteractiveElements.filter(function(el) {
      return isInFirstViewport(el.getBoundingClientRect());
    });
    var contentBelowFold = visibleInteractiveElements.some(function(el) {
      return el.getBoundingClientRect().top >= viewportHeight * 0.92;
    }) || canvases.some(function(info) {
      return info.visible && !info.inFirstViewport;
    });
    var documentHeight = Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.documentElement ? document.documentElement.offsetHeight : 0
    );
    var scrollHeightRatio = viewportHeight ? documentHeight / viewportHeight : 1;
    var hasPrimaryInteractionInFirstViewport = interactiveInFirstViewport.length > 0 || hasNonBlankCanvasInFirstViewport;
    var firstViewportNeedsScrollToPlay = scrollHeightRatio > 1.15 && !hasPrimaryInteractionInFirstViewport && contentBelowFold;

    function textish(value) {
      return String(value && value.baseVal ? value.baseVal : value || "");
    }

    function hasInteractiveDescendant(element) {
      return Boolean(element.querySelector("button,a,input,select,textarea,summary,canvas,svg,[role='button'],[role='slider'],[role='textbox'],[role='checkbox'],[role='radio'],[role='switch']"));
    }

    var largePassivePanels = visibleElements.filter(function(el) {
      if (/^(html|body|main)$/i.test(el.tagName || "")) return false;
      var rect = el.getBoundingClientRect();
      var ownText = (el.innerText || "").trim();
      var descriptor = [
        textish(el.id),
        textish(el.className),
        textish(el.getAttribute("role")),
        textish(el.getAttribute("aria-label")),
        ownText.slice(0, 120)
      ].join(" ").toLowerCase();
      var looksPassive = /(result|score|status|notice|message|log|output|record|summary)/i.test(descriptor);
      var isLargeTopPanel = viewportHeight && rect.top >= -4 && rect.top < viewportHeight * 0.45 && rect.height > viewportHeight * 0.35;
      return looksPassive && isLargeTopPanel && ownText.length < 220 && !hasInteractiveDescendant(el);
    });
    var controlText = elements
      .filter(function(el) { return /^(button|a|input)$/i.test(el.tagName) || el.getAttribute("role") === "button"; })
      .map(function(el) { return (el.innerText || el.value || el.getAttribute("aria-label") || "").trim(); })
      .join(" ");
    var hasRestartLikeControl = /(restart|reset|again|start|play|重新|重开|再来|开始)/i.test(controlText + " " + text);
    var hasSoundLikeControl = /(mute|sound|audio|volume|静音|声音|音效)/i.test(controlText + " " + text);
    var hasImmediateGameOver = /(game\s*over|you\s*(lost|lose|died)|failed|failure|游戏结束|挑战失败|失败了|你输了|再来一局)/i.test(text)
      && !/(点击开始|开始游戏|按键开始|press\s+start|tap\s+to\s+start|ready|准备|start\s+button)/i.test(text);
    var looksBlank = !text && visibleElements.length < 3 && !hasNonBlankCanvas;
    var blankReason = looksBlank ? "no text, too few visible elements, and no nonblank canvas" : "";

    return {
      textLength: text.length,
      textSignature: text.slice(0, 300),
      visibleElementCount: visibleElements.length,
      hasCanvas: canvases.length > 0,
      hasNonBlankCanvas: hasNonBlankCanvas,
      canvasCount: canvases.length,
      canvasSignatures: canvases.map(function(info) { return info.signature; }),
      visualSignature: [visibleElements.length, canvases.map(function(info) { return info.signature; }).join("|")].join(":"),
      hasRestartLikeControl: hasRestartLikeControl,
      hasSoundLikeControl: hasSoundLikeControl,
      viewport: { width: viewportWidth, height: viewportHeight },
      documentHeight: documentHeight,
      scrollHeightRatio: Math.round(scrollHeightRatio * 100) / 100,
      visibleInteractiveElementCount: visibleInteractiveElements.length,
      interactiveInFirstViewportCount: interactiveInFirstViewport.length,
      hasNonBlankCanvasInFirstViewport: hasNonBlankCanvasInFirstViewport,
      hasPrimaryInteractionInFirstViewport: hasPrimaryInteractionInFirstViewport,
      firstViewportNeedsScrollToPlay: firstViewportNeedsScrollToPlay,
      largePassivePanelCount: largePassivePanels.length,
      hasImmediateGameOver: hasImmediateGameOver,
      looksBlank: looksBlank,
      blankReason: blankReason
    };
  });
}

function getPlaywrightState() {
  if (getPlaywrightState.cache) return getPlaywrightState.cache;
  try {
    getPlaywrightState.cache = { available: true, playwright: require("playwright"), reason: "" };
  } catch (firstError) {
    try {
      getPlaywrightState.cache = { available: true, playwright: require("playwright-core"), reason: "" };
    } catch (secondError) {
      getPlaywrightState.cache = { available: false, playwright: null, reason: secondError.message || firstError.message };
    }
  }
  return getPlaywrightState.cache;
}

function extractInlineScripts(html) {
  const scripts = [];
  const pattern = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match = null;
  while ((match = pattern.exec(html))) {
    scripts.push(match[1]);
  }
  return scripts;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function addIssueIf(issues, condition, severity, code, message) {
  if (condition) issues.push({ severity, code, message });
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = `${issue.severity}:${issue.code}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recordQualityEvent(event) {
  const safeEvent = {
    at: new Date().toISOString(),
    ...event
  };
  try {
    fs.appendFileSync(QUALITY_LOG_FILE, JSON.stringify(safeEvent) + "\n", "utf8");
  } catch (error) {
    logError(error);
  }
}

async function requestGameHtml(messages, options = {}) {
  const models = uniqueModels(options.ruleHeavy
    ? [DEEPSEEK_RULE_MODEL, DEEPSEEK_MODEL, DEEPSEEK_FALLBACK_MODEL]
    : [DEEPSEEK_MODEL, DEEPSEEK_FALLBACK_MODEL]);

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

function uniqueModels(models) {
  return models.filter(Boolean).filter((model, index, list) => list.indexOf(model) === index);
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
  const payload = buildDeepSeekPayload(model, messages);
  let response;
  try {
    response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify(payload)
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

  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content !== "string" || !content.trim()) {
    const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.slice(0, 500) : "";
    const error = new Error("DeepSeek 没有返回可用的 HTML 内容。");
    error.statusCode = 502;
    error.publicDetail = reasoning ? "模型只返回了 reasoning_content，未返回最终 HTML；已尝试 fallback。" : undefined;
    throw error;
  }

  return cleanAndValidateHtml(content);
}

function buildDeepSeekPayload(model, messages) {
  const payload = {
    model,
    messages,
    max_tokens: DEEPSEEK_MAX_TOKENS,
    temperature: 0.65,
    stream: false
  };

  if (model !== "deepseek-chat") {
    payload.thinking = { type: DEEPSEEK_THINKING };
    payload.reasoning_effort = DEEPSEEK_REASONING_EFFORT;
  }

  return payload;
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

function readJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
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

function normalizeHtmlInput(value, maxBytes = MAX_BODY_BYTES) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error("html 不能为空。");
    error.statusCode = 400;
    throw error;
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes - 20_000) {
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
