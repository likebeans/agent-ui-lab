import { LayoutTemplate } from 'lucide-react';
import { STATIC_MODE } from '../../../shared/runtime';
import type { LabDefinition } from '../types';
import { adaptLegacyChat, adaptLegacyLab } from '../legacy';

export default {
  id: 'a2ui',
  title: '声明式 UI 与数据绑定',
  description: '声明生成组件',
  topicIds: ['generated-ui', 'data-binding'],
  protocols: ['a2ui'],
  protocolVersions: { a2ui: '0.9.1 teaching subset' },
  order: 20,
  status: 'available',
  modes: ['local', 'pages'],
  docs: 'a2ui',
  legacyHash: '#a2ui',
  sourceReferences: ['shared/a2ui.ts', 'shared/a2ui-agent.ts', 'src/labs/A2uiLab.tsx'],
  presentation: {
    name: 'A2UI',
    subtitle: '让一份声明，生长为真实界面',
    label: '声明式 UI 与数据绑定',
    description: '检查组件描述、修改绑定数据，再把表单操作送回服务端。',
    icon: LayoutTemplate,
    color: 'teal',
    transport: STATIC_MODE ? 'JSON · 浏览器内' : 'JSON · HTTP',
    docs: 'https://a2ui.org',
    steps: ['下发组件描述', '更新数据模型', 'Renderer 渲染', '用户动作回传'],
    question: 'Agent 不写 HTML，怎样决定页面上出现什么？',
    explanation:
      '服务端描述“有哪些组件、它们如何组合、值绑定在哪里”。客户端用允许的组件目录把描述映射为自己的原生组件。UI 结构与数据模型分别更新；用户点击后产生结构化动作，让服务端决定下一次变化。',
    concepts: [
      [
        '组件目录',
        'Renderer 只实例化支持的组件。协议数据不是 JavaScript，也不会被当作 HTML 执行。这个实验明确实现有限组件集合。',
      ],
      [
        '结构与数据分离',
        '组件通过路径读取数据模型。同一棵组件树可以显示不同的数据；修改表单时，绑定值也同步更新。',
      ],
      [
        '动作形成闭环',
        '按钮 action 携带已解析的表单值返回服务端，服务端验证后下发更新。真实业务中的鉴权和持久化属于服务端。',
      ],
    ],
    exercise:
      '修改组件描述中的标签或绑定路径，比较结构更新和数据更新。再添加一个受支持的组件，观察 Renderer 如何处理它。',
  },
  load: () => import('../A2uiLab').then((module) => ({ default: adaptLegacyLab(module.default) })),
  chat: {
    protocol: 'a2ui',
    short: '声明生成组件',
    prompt: '生成一个成都两日游的需求表单，我来补充信息',
    starter: '生成一个出行需求表单',
    suggestion: '打开这个城市的活动应用，让我挑一挑',
    source: 'shared/a2ui-agent.ts → A2UI schema → SurfaceRenderer',
    load: () =>
      import('../A2uiLab').then((module) => ({
        default: adaptLegacyChat(module.A2uiChatTurn, 'a2ui'),
      })),
  },
} satisfies LabDefinition;
