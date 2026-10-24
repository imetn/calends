// AI 产品与 AI 开发工具：图标来自 lobe-icons（MIT），放在 public/ai
import type { CatalogEntry, CatalogCat } from '../catalog.ts';

/** 有译名的条目：名称在 catalog.name.<file> 里按当前语言显示 */
const LOCALIZED = new Set(['qwen', 'doubao', 'yuanbao', 'zhipu', 'coze', 'kling', 'hailuo', 'hunyuan']);

const ai = (name: string, file: string, url: string, aka: string[] = [], cat: CatalogCat = 'ai'): CatalogEntry => ({
  name,
  file,
  aka,
  cat,
  url,
  icon: `/ai/${file}.svg`,
  localized: LOCALIZED.has(file),
});

const entries: CatalogEntry[] = [
  ai('ChatGPT', 'openai', 'https://chatgpt.com', ['openai', 'gpt', 'chatgpt plus', 'chatgpt pro']),
  ai('Claude', 'claude', 'https://claude.ai', ['anthropic', 'claude pro', 'claude max']),
  ai('Gemini', 'gemini', 'https://gemini.google.com', ['google ai pro', 'google one ai', 'bard']),
  ai('Grok', 'grok', 'https://grok.com', ['xai', 'supergrok']),
  ai('Perplexity', 'perplexity', 'https://www.perplexity.ai', ['perplexity pro']),
  ai('DeepSeek', 'deepseek', 'https://www.deepseek.com', ['深度求索']),
  ai('Kimi', 'kimi', 'https://kimi.com', ['moonshot', '月之暗面', 'kimi code']),
  ai('通义千问', 'qwen', 'https://tongyi.aliyun.com', ['qwen', '通义', '千问']),
  ai('豆包', 'doubao', 'https://www.doubao.com', ['doubao', '字节']),
  ai('腾讯元宝', 'yuanbao', 'https://yuanbao.tencent.com', ['yuanbao', '元宝']),
  ai('智谱清言', 'zhipu', 'https://chatglm.cn', ['zhipu', 'chatglm', 'glm']),
  ai('MiniMax', 'minimax', 'https://www.minimax.io', ['海螺']),
  ai('Mistral', 'mistral', 'https://mistral.ai', ['le chat']),
  ai('Poe', 'poe', 'https://poe.com'),
  ai('Monica', 'monica', 'https://monica.im'),
  ai('Manus', 'manus', 'https://manus.im'),
  ai('OpenRouter', 'openrouter', 'https://openrouter.ai'),
  ai('Microsoft Copilot', 'copilot', 'https://copilot.microsoft.com', ['copilot pro', 'microsoft 365 copilot']),
  ai('GitHub Copilot', 'githubcopilot', 'https://github.com/features/copilot', ['copilot'], 'tools'),
  ai('Cursor', 'cursor', 'https://cursor.com', ['cursor pro'], 'tools'),
  ai('Windsurf', 'windsurf', 'https://windsurf.com', ['codeium'], 'tools'),
  ai('Trae', 'trae', 'https://www.trae.ai', [], 'tools'),
  ai('Cline', 'cline', 'https://cline.bot', [], 'tools'),
  ai('Devin', 'devin', 'https://devin.ai', ['cognition'], 'tools'),
  ai('v0', 'v0', 'https://v0.dev', ['vercel'], 'tools'),
  ai('Lovable', 'lovable', 'https://lovable.dev', [], 'tools'),
  ai('Replit', 'replit', 'https://replit.com', [], 'tools'),
  ai('Hugging Face', 'huggingface', 'https://huggingface.co', ['hf'], 'tools'),
  ai('扣子', 'coze', 'https://www.coze.cn', ['coze']),
  ai('Midjourney', 'midjourney', 'https://www.midjourney.com', ['mj']),
  ai('Ideogram', 'ideogram', 'https://ideogram.ai'),
  ai('Krea', 'krea', 'https://www.krea.ai'),
  ai('Runway', 'runway', 'https://runwayml.com', ['runwayml']),
  ai('Pika', 'pika', 'https://pika.art'),
  ai('可灵', 'kling', 'https://klingai.com', ['kling']),
  ai('海螺 AI', 'hailuo', 'https://hailuoai.com', ['hailuo']),
  ai('Suno', 'suno', 'https://suno.com'),
  ai('Udio', 'udio', 'https://www.udio.com'),
  ai('ElevenLabs', 'elevenlabs', 'https://elevenlabs.io', ['11labs']),
  ai('腾讯混元', 'hunyuan', 'https://hunyuan.tencent.com', ['hunyuan']),
  ai('Notion', 'notion', 'https://www.notion.so', ['notion ai'], 'productivity'),
  ai('Figma', 'figma', 'https://www.figma.com', [], 'tools'),
];

export default entries;
