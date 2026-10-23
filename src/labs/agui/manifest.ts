import { Radio } from 'lucide-react';
import { STATIC_MODE } from '../../../shared/runtime';
import type { LabDefinition } from '../types';
import { adaptLegacyChat, adaptLegacyLab } from '../legacy';

export default {
  id: 'agui',
  title: '事件流与状态同步',
  description: '事件驱动回复',
  topicIds: ['streaming', 'task-control', 'shared-state'],
  protocols: ['agui'],
  protocolVersions: { agui: '1.0 / core 1.0.3' },
  order: 10,
  status: 'available',
  modes: ['local', 'pages'],
  docs: 'ag-ui',
  legacyHash: '#agui',
  sourceReferences: ['shared/agui-agent.ts', 'shared/agui.ts', 'src/labs/AguiLab.tsx'],
  presentation: {
    name: 'AG-UI',
    subtitle: '让 Agent 的每一步，被界面看见',
    label: '事件流与状态同步',
    description: '从一条请求开始，看文本、工具调用和应用状态如何实时抵达前端。',
    icon: Radio,
    color: 'purple',
    transport: STATIC_MODE ? '浏览器内事件流' : 'HTTP · SSE',
    docs: 'https://docs.ag-ui.com',
    steps: [
      '发送用户请求',
      'Agent 产生事件',
      STATIC_MODE ? '本地流传输' : 'SSE 传输',
      'Reducer 更新 UI',
    ],
    question: '消息还没生成完，界面为什么已经开始更新？',
    explanation:
      'Agent 不必等待整个任务完成才返回一个 JSON。它把一次运行拆成有类型的事件；前端顺序消费这些事件，再把文本片段、工具参数和状态变更投影到界面。SSE 是本实验选择的传输方式，AG-UI 的核心是事件契约。',
    concepts: [
      [
        '运行生命周期',
        'RUN_STARTED → 内容、工具与状态事件 → RUN_FINISHED；失败用 RUN_ERROR。取消请求不等于完成运行。',
      ],
      [
        '文本与工具独立',
        'TEXT_MESSAGE_CONTENT 增量追加文字；TOOL_CALL_ARGS 拼接参数。工具调用结束和工具结果到达是不同事件。',
      ],
      [
        '共享状态',
        'STATE_SNAPSHOT 提供完整状态，STATE_DELTA 使用 RFC 6902 JSON Patch 描述变化。前端的任务卡片由状态驱动。',
      ],
    ],
    exercise:
      '修改服务端每次发出的文本片段或 STATE_DELTA，观察事件顺序、工具执行状态与页面变化。试试中途取消和故障场景。',
  },
  load: () => import('../AguiLab').then((module) => ({ default: adaptLegacyLab(module.default) })),
  chat: {
    protocol: 'agui',
    short: '事件驱动回复',
    prompt: '帮我规划杭州三日游，喜欢慢节奏和本地小吃',
    starter: '帮我规划杭州三日游',
    suggestion: '把这些出行需求做成一个可填写的表单',
    source: 'shared/agui-agent.ts → shared/agui.ts → AguiChatTurn',
    load: () =>
      import('../../components/AguiChatTurn').then((module) => ({
        default: adaptLegacyChat(module.AguiChatTurn, 'agui'),
      })),
  },
} satisfies LabDefinition;
