import { PanelsTopLeft } from 'lucide-react';
import { STATIC_MODE } from '../../../shared/runtime';
import type { LabDefinition } from '../types';

export default {
  id: 'a2ui-compatibility',
  title: 'A2UI 兼容与编辑冲突',
  description: '声明遇到能力限制、字段错误和远端更新时，怎样保护用户输入。',
  topicIds: ['catalog-compatibility', 'form-validation', 'concurrent-editing'],
  protocols: ['a2ui'],
  protocolVersions: { a2ui: '0.9.1 teaching subset' },
  order: 50,
  status: 'available',
  modes: ['local', 'pages'],
  docs: 'labs/a2ui-compatibility',
  sourceReferences: [
    'shared/labs/a2ui-compatibility/engine.ts',
    'shared/labs/a2ui-compatibility/draft.ts',
    'src/components/A2uiSurfaceRenderer.tsx',
    'src/labs/a2ui-compatibility/Lab.tsx',
  ],
  presentation: {
    name: 'A2UI 兼容与编辑冲突',
    subtitle: '让界面变化尊重客户端能力和用户草稿',
    label: '能力 · 校验 · 冲突',
    description: '检查 catalog 和组件能力，分清字段校验与业务校验，再处理两个页面之间的更新。',
    icon: PanelsTopLeft,
    color: 'teal',
    transport: STATIC_MODE ? 'A2UI · 浏览器内模拟' : 'A2UI · HTTP',
    steps: ['检查能力', '编辑与校验', '比较远端更新', '按版本提交动作'],
    question: '远端表单更新时，用户还没提交的输入应该怎么办？',
    explanation:
      '协议描述组件和绑定；应用还要判断客户端能否渲染、哪些输入是用户草稿，以及动作是否针对当前业务版本。这个实验使用同一个受控 Renderer，并在协议消息之外保存版本与字段规则。',
    concepts: [
      [
        '能力检查先于渲染',
        '只使用本地注册的 basic catalog 与六类组件。未知 catalog 或不支持的组件会显示可读文字，不下载组件代码。',
      ],
      [
        '校验分层',
        '字段规则检查格式与范围；服务端重新校验输入，并检查预算是否满足行程。错误能定位到组件、绑定路径和动作。',
      ],
      [
        '草稿与远端分开',
        '未修改字段接受远端值，双方修改同一字段时保留草稿并要求用户选择。过期业务版本或 Surface 的动作由服务端拒绝。',
      ],
    ],
    exercise:
      '在两个页面打开同一份本地表单：一边修改天数，一边延长服务端行程。读取更新并选择保留草稿或采用远端，再尝试发送之前保存的旧动作。',
  },
  load: () => import('./Lab'),
} satisfies LabDefinition;
