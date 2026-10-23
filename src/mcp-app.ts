import { App, PostMessageTransport, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';

const TOOL_NAME = 'get_trip_activities';
const cities = [
  { id: 'shanghai', label: '上海' },
  { id: 'chengdu', label: '成都' },
  { id: 'hangzhou', label: '杭州' },
] as const;

type CityId = (typeof cities)[number]['id'];
type TripData = {
  city: CityId;
  cityLabel: string;
  theme: string;
  activities: Array<{
    id: string;
    title: string;
    summary: string;
    duration: string;
    pace: string;
  }>;
  source: 'local-fixture';
  deterministic: true;
};

const rootElement = document.querySelector<HTMLDivElement>('#app');
if (!rootElement) throw new Error('找不到 MCP App 根节点。');
const root: HTMLDivElement = rootElement;
const appRoot: HTMLDivElement = root;
const layout = appRoot.dataset.layout === 'list' ? 'list' : 'cards';

const app = new App(
  { name: 'intelligent-ui-trip-picker', version: '0.1.0' },
  {},
  { autoResize: true, strict: true },
);

let active = true;
let connected = false;
let pending = false;
let selectedCity: CityId = 'shanghai';
let data: TripData | null = null;
let error = '';
let status = '正在与宿主建立 MCP Apps 握手…';

function isTripData(value: unknown): value is TripData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TripData>;
  return (
    typeof candidate.city === 'string' &&
    typeof candidate.cityLabel === 'string' &&
    typeof candidate.theme === 'string' &&
    candidate.source === 'local-fixture' &&
    candidate.deterministic === true &&
    Array.isArray(candidate.activities)
  );
}

function applyToolResult(result: { isError?: boolean; structuredContent?: unknown }): void {
  if (!active) return;
  if (result.isError) throw new Error('工具返回了错误结果。');
  if (!isTripData(result.structuredContent))
    throw new Error('工具结果缺少预期的 structuredContent。');
  data = result.structuredContent;
  selectedCity = data.city;
  error = '';
  status = `已通过 MCP 工具读取 ${data.cityLabel} 的本地 fixture。`;
  render();
}

async function chooseCity(city: CityId): Promise<void> {
  if (!active || !connected || pending) return;
  selectedCity = city;
  pending = true;
  error = '';
  status = `正在请宿主代理调用 ${TOOL_NAME}…`;
  render();

  try {
    const result = await app.callServerTool({
      name: TOOL_NAME,
      arguments: { city },
    });
    if (!active) return;
    applyToolResult(result);
  } catch (cause) {
    if (!active) return;
    error = cause instanceof Error ? cause.message : '工具调用失败，请重试。';
    status = 'App 已连接，但这次工具调用没有成功。';
    render();
  } finally {
    if (!active) return;
    pending = false;
    render();
  }
}

function makeText(tag: keyof HTMLElementTagNameMap, text: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function render(): void {
  if (!active) return;
  appRoot.replaceChildren();
  appRoot.setAttribute('aria-busy', String(pending || !connected));

  const shell = document.createElement('main');
  shell.className = `app layout-${layout}`;

  const top = document.createElement('div');
  top.className = 'top';
  const intro = document.createElement('div');
  intro.append(
    makeText('div', 'MCP APP · TRIP PICKER', 'eyebrow'),
    makeText('h1', '今天，想怎样认识一座城市？'),
    makeText('p', '选择城市后，App 会经由宿主调用同一个只读 MCP 工具。'),
  );
  top.append(
    intro,
    makeText(
      'span',
      layout === 'list' ? '确定性数据 · 列表布局' : '确定性数据 · 无 LLM',
      'fixture',
    ),
  );
  shell.append(top);

  const statusBox = makeText('div', error || status, `status${error ? ' error' : ''}`);
  statusBox.setAttribute('role', error ? 'alert' : 'status');
  statusBox.setAttribute('aria-live', 'polite');
  shell.append(statusBox);

  const cityRow = document.createElement('div');
  cityRow.className = 'cities';
  cityRow.setAttribute('aria-label', '选择城市');
  for (const city of cities) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'city';
    button.textContent = city.label;
    button.disabled = !connected || pending;
    button.setAttribute('aria-pressed', String(selectedCity === city.id));
    button.addEventListener('click', () => {
      void chooseCity(city.id);
    });
    cityRow.append(button);
  }
  shell.append(cityRow);

  if (data) {
    const heading = document.createElement('div');
    heading.className = 'heading';
    heading.append(
      makeText('h2', `${data.cityLabel} · ${data.theme}`),
      makeText('span', `${data.activities.length} 项只读 fixture`),
    );
    shell.append(heading);

    const list = document.createElement('section');
    list.className = 'activities';
    list.setAttribute('aria-label', `${data.cityLabel}活动`);
    for (const activity of data.activities) {
      const card = document.createElement('article');
      card.className = 'activity';
      card.append(makeText('strong', activity.title), makeText('p', activity.summary));
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.append(makeText('span', activity.duration), makeText('span', `· ${activity.pace}`));
      card.append(meta);
      list.append(card);
    }
    shell.append(list);
  } else {
    shell.append(makeText('div', '等待宿主发送首次 tool-input 与 tool-result。', 'empty'));
  }

  if (error) {
    const retry = makeText('button', '重试当前城市', 'retry') as HTMLButtonElement;
    retry.type = 'button';
    retry.disabled = pending || !connected;
    retry.addEventListener('click', () => {
      void chooseCity(selectedCity);
    });
    shell.append(retry);
  }

  shell.append(
    makeText('div', 'App → postMessage → Host allowlist → MCP Client → fixture tool', 'foot'),
  );
  appRoot.append(shell);
}

app.addEventListener('hostcontextchanged', ({ theme }) => {
  if (active && theme) applyDocumentTheme(theme);
});

app.addEventListener('toolinput', ({ arguments: toolArguments }) => {
  if (!active) return;
  const city = toolArguments?.city;
  if (cities.some((item) => item.id === city)) selectedCity = city as CityId;
  status = '宿主已发送首次完整工具输入，等待工具结果…';
  render();
});

app.addEventListener('toolresult', (result) => {
  try {
    applyToolResult(result);
  } catch (cause) {
    if (!active) return;
    error = cause instanceof Error ? cause.message : '无法读取首次工具结果。';
    render();
  }
});

app.onteardown = async () => {
  active = false;
  appRoot.setAttribute('aria-busy', 'false');
  appRoot.replaceChildren(makeText('p', '宿主已结束此 MCP App。'));
  return {};
};

window.addEventListener(
  'pagehide',
  () => {
    active = false;
    void app.close().catch(() => undefined);
  },
  { once: true },
);

async function connect(): Promise<void> {
  try {
    await app.connect(new PostMessageTransport(window.parent, window.parent));
    if (active) {
      applyDocumentTheme(app.getHostContext()?.theme ?? 'light');
      connected = true;
      if (!data) status = '握手完成，等待宿主发送首次工具数据。';
      render();
    }
  } catch (cause) {
    if (active) {
      error = cause instanceof Error ? cause.message : '无法连接 MCP Apps 宿主。';
      status = '握手失败。';
      render();
    }
  }
}

render();
void connect();
