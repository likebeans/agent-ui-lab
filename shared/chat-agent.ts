import { z } from 'zod';
import type { ChatRoute } from './chat';

export const chatInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(500),
    mode: z.enum(['auto', 'agui', 'a2ui', 'mcp']).default('auto'),
    context: z
      .object({
        city: z.enum(['杭州', '成都', '上海']),
        days: z.number().int().min(1).max(7),
      })
      .default({ city: '杭州', days: 3 }),
  })
  .strict();

const chineseDays: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
};

function promptError(message: string): never {
  // Both HTTP and Pages expose the first Zod issue as the request error.
  throw new z.ZodError([{ code: 'custom', path: ['prompt'], message }]);
}

function tripDays(prompt: string, fallback: number): number {
  const values: number[] = [];
  // Capture the whole quantity, including unsupported decimals, signs and ranges,
  // before validating it. Matching only 1–7 would turn “12天” into “2天”.
  const mentions = prompt
    .normalize('NFKC')
    .matchAll(
      /([+\-−负]?\s*(?:\.[\d零〇一二两三四五六七八九十百千万亿]|[\d零〇一二两三四五六七八九十百千万亿半])[\d零〇一二两三四五六七八九十百千万亿.点半]*(?:\s*[-−–—~至到/或和、]\s*[\d零〇一二两三四五六七八九十百千万亿.点半]+)*)\s*(?:天|日)半?/gu,
    );
  for (const mention of mentions) {
    const quantity = mention[1].trim();
    if (mention[0].endsWith('半') || !/^[1-7一二两三四五六七]$/u.test(quantity))
      promptError(`行程天数仅支持 1–7 天的整数，请修改“${mention[0].trim()}”后再发送。`);
    values.push(chineseDays[quantity] ?? Number(quantity));
  }
  // Equivalent repeats are unambiguous; conflicting values require an explicit edit.
  if (new Set(values).size > 1)
    promptError('检测到多个不同的行程天数，请只保留一个 1–7 天的整数后再发送。');
  return values[0] ?? fallback;
}

export function routeChat(input: unknown): ChatRoute {
  const { prompt, mode, context } = chatInputSchema.parse(input);
  const cities = ['杭州', '成都', '上海'] as const;
  const mentionedCity = cities.find((city) => prompt.includes(city));
  const days = tripDays(prompt, context.days);
  const nextContext = { city: mentionedCity ?? context.city, days };
  const protocol =
    mode !== 'auto'
      ? mode
      : /mcp|应用|活动浏览|活动选择|自带\s*ui|打开.*(?:活动|工具)/iu.test(prompt)
        ? 'mcp'
        : /a2ui|表单|组件|生成.*界面|做成.*界面|填写|收集需求/iu.test(prompt)
          ? 'a2ui'
          : 'agui';
  const descriptions = {
    agui: '用 AG-UI 流传输规划过程：文本、工具参数和共享状态分别驱动消息中的不同部分。',
    a2ui: '用 A2UI 描述需求表单：服务端返回组件声明与数据模型，聊天宿主用组件目录渲染。',
    mcp: '调用带 UI 资源的 MCP 工具：宿主读取 ui:// HTML，并把工具应用嵌入这条回复。',
  };
  return { protocol, context: nextContext, explanation: descriptions[protocol] };
}
