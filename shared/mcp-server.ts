import { McpServer } from '@modelcontextprotocol/server';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';

export const MCP_APP_RESOURCE_URI = 'ui://intelligent-ui/trip-picker';
export const MCP_APP_LIST_RESOURCE_URI = 'ui://intelligent-ui/trip-picker-list';
export const MCP_TRIP_TOOL_NAME = 'get_trip_activities';

type AppLayout = 'cards' | 'list';
const CITY_IDS = ['shanghai', 'chengdu', 'hangzhou'] as const;
type CityId = (typeof CITY_IDS)[number];

const cityFixtures = {
  shanghai: {
    cityLabel: '上海',
    theme: '城市建筑与滨水漫步',
    activities: [
      {
        id: 'sh-bund',
        title: '外滩建筑散步',
        summary: '沿历史建筑群走到外白渡桥，观察城市天际线。',
        duration: '2 小时',
        pace: '轻松',
      },
      {
        id: 'sh-museum',
        title: '城市博物馆路线',
        summary: '从人民广场出发，选择一座免费常设展馆。',
        duration: '3 小时',
        pace: '室内',
      },
      {
        id: 'sh-lane',
        title: '梧桐街区慢行',
        summary: '用步行连接街角小店、旧居与社区花园。',
        duration: '2.5 小时',
        pace: '慢行',
      },
    ],
  },
  chengdu: {
    cityLabel: '成都',
    theme: '公园城市与在地生活',
    activities: [
      {
        id: 'cd-park',
        title: '人民公园早茶',
        summary: '在公园里观察本地日常，再沿老街步行。',
        duration: '2 小时',
        pace: '轻松',
      },
      {
        id: 'cd-museum',
        title: '博物馆半日线',
        summary: '从城市历史展开始，按兴趣挑选专题展。',
        duration: '3.5 小时',
        pace: '室内',
      },
      {
        id: 'cd-greenway',
        title: '绿道骑行',
        summary: '选择一段平缓绿道，途中停靠社区驿站。',
        duration: '3 小时',
        pace: '骑行',
      },
    ],
  },
  hangzhou: {
    cityLabel: '杭州',
    theme: '湖山步道与宋韵城市',
    activities: [
      {
        id: 'hz-lake',
        title: '西湖清晨步道',
        summary: '避开高峰，沿湖串联堤岸、桥与观景点。',
        duration: '2.5 小时',
        pace: '慢行',
      },
      {
        id: 'hz-canal',
        title: '运河文化路线',
        summary: '从桥西街区出发，认识手工艺与仓储建筑。',
        duration: '3 小时',
        pace: '轻松',
      },
      {
        id: 'hz-tea',
        title: '茶园观察课',
        summary: '在公共步道认识茶树生长，不进入生产区域。',
        duration: '2 小时',
        pace: '户外',
      },
    ],
  },
} satisfies Record<
  CityId,
  {
    cityLabel: string;
    theme: string;
    activities: Array<{
      id: string;
      title: string;
      summary: string;
      duration: string;
      pace: string;
    }>;
  }
>;

const TripInput = z.object({
  city: z.enum(CITY_IDS).default('shanghai'),
});

const ActivityOutput = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  duration: z.string(),
  pace: z.string(),
});

const TripOutput = z.object({
  city: z.enum(CITY_IDS),
  cityLabel: z.string(),
  theme: z.string(),
  activities: z.array(ActivityOutput),
  source: z.literal('local-fixture'),
  deterministic: z.literal(true),
});

const appCsp = {
  connectDomains: [],
  resourceDomains: [],
  frameDomains: [],
  baseUriDomains: [],
};

export function createTripMcpServer(
  loadHtml: (layout: 'cards' | 'list') => Promise<string>,
): McpServer {
  const server = new McpServer(
    {
      name: 'intelligent-ui-lab-mcp',
      version: '0.1.0',
    },
    {
      instructions: '本地确定性教学服务：所有行程活动均来自只读 fixture，不调用 LLM 或外部网络。',
    },
  );

  registerAppTool(
    server,
    MCP_TRIP_TOOL_NAME,
    {
      title: '读取城市活动',
      description: '从本地只读 fixture 返回指定城市的活动建议；结果完全确定，不使用 LLM。',
      inputSchema: TripInput,
      outputSchema: TripOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: MCP_APP_RESOURCE_URI,
          visibility: ['model', 'app'],
        },
      },
    },
    async ({ city }) => {
      const fixture = cityFixtures[city];
      const structuredContent = {
        city,
        ...fixture,
        activities: fixture.activities.map((activity) => ({ ...activity })),
        source: 'local-fixture' as const,
        deterministic: true as const,
      };

      return {
        content: [
          {
            type: 'text',
            text: `已从本地 fixture 读取 ${fixture.cityLabel} 的 ${fixture.activities.length} 项活动（确定性工具，无 LLM）。`,
          },
        ],
        structuredContent,
      };
    },
  );

  function registerTripAppResource(
    name: string,
    title: string,
    description: string,
    uri: string,
    layout: AppLayout,
  ): void {
    registerAppResource(
      server,
      name,
      uri,
      {
        title,
        description,
        _meta: {
          ui: {
            csp: appCsp,
            prefersBorder: true,
          },
        },
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_TYPE,
            text: await loadHtml(layout),
            _meta: {
              ui: {
                csp: appCsp,
                prefersBorder: true,
              },
            },
          },
        ],
      }),
    );
  }

  registerTripAppResource(
    '城市活动选择器',
    '城市活动选择器 MCP App',
    '使用官方 MCP Apps App/PostMessageTransport 的本地卡片界面。',
    MCP_APP_RESOURCE_URI,
    'cards',
  );
  registerTripAppResource(
    '城市活动列表',
    '城市活动列表 MCP App',
    '与默认资源使用相同 App 脚本、数据和工具，仅把活动改为列表布局。',
    MCP_APP_LIST_RESOURCE_URI,
    'list',
  );

  return server;
}
