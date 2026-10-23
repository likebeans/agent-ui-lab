import { Boxes } from 'lucide-react';
import { STATIC_MODE } from '../../../shared/runtime';
import type { LabDefinition } from '../types';
import { adaptLegacyChat, adaptLegacyLab } from '../legacy';

export default {
  id: 'mcp',
  title: '工具、资源与应用桥接',
  description: '工具自带应用',
  topicIds: ['embedded-apps', 'host-capabilities'],
  protocols: ['mcp'],
  protocolVersions: { mcp: 'Apps SDK 2.0.3 / MCP v2 SDK' },
  order: 30,
  status: 'available',
  modes: ['local', 'pages'],
  docs: 'mcp-apps',
  legacyHash: '#mcp',
  sourceReferences: ['shared/mcp-server.ts', 'src/mcp-app.ts', 'src/labs/McpLab.tsx'],
  presentation: {
    name: 'MCP Apps',
    subtitle: '让工具结果，成为一个可操作的应用',
    label: '工具、资源与应用桥接',
    description: '在沙箱中打开一个工具界面，沿着双向消息看清 Host 与 App 的协作。',
    icon: Boxes,
    color: 'amber',
    transport: STATIC_MODE ? 'MCP · InMemoryTransport' : 'MCP · JSON-RPC',
    docs: 'https://modelcontextprotocol.io/docs/extensions/apps',
    steps: ['发现工具', '读取 UI 资源', 'App 握手', '调用宿主工具'],
    question: '工具为什么可以返回一个应用，而不只是一段文字？',
    explanation:
      '工具通过元数据关联一个 ui:// 资源。Host 读取 HTML 资源，把应用放进隔离的 iframe，并通过 AppBridge 与 App 建立 JSON-RPC 通道。应用请求调用工具时，由 Host 代理到 MCP Server。',
    concepts: [
      [
        '工具与资源',
        'tools/list 发现工具和关联的 resourceUri，resources/read 获得 text/html;profile=mcp-app 资源。工具结果可以同时包含文本和 structuredContent。',
      ],
      [
        'App / Host 分工',
        'App 负责交互，Host 负责能力协商、工具代理与权限边界。这里使用官方 App、AppBridge 与 PostMessageTransport。',
      ],
      [
        '隔离与能力',
        '实验仅加载本项目生成的 UI，iframe 不允许同源访问，宿主限制可调用工具。生产环境仍需要独立资源源站、完整 CSP 和权限策略。',
      ],
    ],
    exercise:
      '修改工具的 structuredContent，重新打开嵌入式应用。比较工具调用与 App 收到结果的边界。',
  },
  load: () => import('../McpLab').then((module) => ({ default: adaptLegacyLab(module.default) })),
  chat: {
    protocol: 'mcp',
    short: '工具自带应用',
    prompt: '打开上海的城市活动应用',
    starter: '打开城市活动应用',
    suggestion: '再帮我规划一个三日游，加入散步路线',
    source: 'tools/list → resources/read → AppBridge → iframe App',
    load: () =>
      import('../McpLab').then((module) => ({
        default: adaptLegacyChat(module.McpChatTurn, 'mcp'),
      })),
  },
} satisfies LabDefinition;
