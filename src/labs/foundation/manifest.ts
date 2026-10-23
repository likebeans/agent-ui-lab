import { FlaskConical } from 'lucide-react';
import { STATIC_MODE } from '../../../shared/runtime';
import type { LabDefinition } from '../types';

export default {
  id: 'foundation',
  title: '实验接入示例',
  description: '通过一份 manifest、一个 engine 和两种运行适配，验证新实验的接入方式。',
  topicIds: ['lab-contract', 'trace-correlation'],
  protocols: [],
  protocolVersions: {},
  order: 40,
  status: 'available',
  modes: ['local', 'pages'],
  docs: 'labs/foundation',
  sourceReferences: [
    'src/labs/foundation/manifest.ts',
    'shared/labs/foundation/engine.ts',
    'src/labs/foundation/Lab.tsx',
  ],
  presentation: {
    name: '实验接入示例',
    subtitle: '从一个独立实验开始扩展',
    label: '公共契约与关联记录',
    description: '修改输入，观察同一逻辑在本地 HTTP 与浏览器内运行时的记录。',
    icon: FlaskConical,
    color: 'purple',
    transport: STATIC_MODE ? '浏览器内' : 'HTTP · JSON',
    steps: ['发现 manifest', '校验输入', '运行共用逻辑', '定位本次记录'],
    question: '增加一个实验，哪些内容属于自己的模块？',
    explanation:
      '实验定义提供入口、学习主题、运行模式、文档与懒加载组件。公共运行接口负责请求、取消信号和记录关联，实验逻辑保持浏览器可用。服务端与静态入口按同一输入输出契约调用它。',
    concepts: [
      ['实验与协议分开', '一个实验可以不使用协议，也可以组合多个协议。ProtocolId 不决定实验数量。'],
      ['载荷保持原样', 'labId、taskId 等关联字段放在 trace 外层，原始请求与协议消息仍可直接对照。'],
      ['运行模式明确', '同一 engine 分别由真实 HTTP 和静态处理器调用；检查器明确区分 transport。'],
    ],
    exercise:
      '复制 foundation 目录，使用新的实验 ID、独立文档和局部样式接入。涉及新接口时，由整合负责人登记 HTTP 与静态 handler。',
  },
  load: () => import('./Lab'),
} satisfies LabDefinition;
