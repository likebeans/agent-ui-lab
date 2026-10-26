import { Workflow } from 'lucide-react';
import { STATIC_MODE } from '../../../shared/runtime';
import type { LabDefinition } from '../types';

export default {
  id: 'enrollment-workflow',
  title: '活动报名：恢复与确认',
  description: '用一个联合任务连接 A2UI 草稿、版本确认、持久事件与报名事实。',
  topicIds: ['composed-workflow', 'human-in-the-loop', 'recovery', 'idempotency'],
  protocols: ['agui', 'a2ui'],
  protocolVersions: { agui: '1.0', a2ui: '0.9.1 teaching subset' },
  order: 80,
  status: 'available',
  modes: ['local', 'pages'],
  docs: 'labs/enrollment-workflow',
  sourceReferences: [
    'shared/labs/enrollment-workflow/engine.ts',
    'shared/labs/enrollment-workflow/surface.ts',
    'server/labs/enrollment-workflow/store.ts',
    'src/labs/enrollment-workflow/Lab.tsx',
  ],
  presentation: {
    name: '活动报名联合实验',
    subtitle: '等待人工输入，仍是同一个任务',
    label: '表单 · 版本确认 · 事件恢复',
    description: '追溯草稿、提议、确认和持久事实之间的完整链路。',
    icon: Workflow,
    color: 'amber',
    transport: STATIC_MODE ? '浏览器内 · 联合模拟' : 'HTTP · SQLite 联合事务',
    steps: ['填写声明表单', '保存版本化提议', '确认或拒绝', '恢复同一任务与事实'],
    question: '任务等待确认时刷新，怎样恢复同一份提议而不重复报名？',
    explanation:
      'A2UI 生成受校验表单，应用命令决定提议和报名，AG-UI 记录执行状态。任务、命令回执、业务事实和事件在同一事务内提交；等待确认期间保留同一运行身份，恢复只读取已提交记录。',
    concepts: [
      [
        '共同身份',
        'taskId、runId、proposalId 与内容版本共同关联一次报名流程；等待输入不结束 run。',
      ],
      ['联合事务', '复用人工确认引擎，在同一存储事务中写入事件和业务事实；重试只返回原命令回执。'],
      [
        '事实恢复',
        '结果未知时查询 checkpoint、事件和报名事实。Pages 仍是页面内存，刷新后显式开始新模拟。',
      ],
    ],
    exercise:
      '保存一条确认命令，修改并保存人数后发送旧确认；再模拟丢失确认响应，查询事实并重放原命令，验证只有一条报名与一份工具结果。',
  },
  load: () => import('./Lab'),
} satisfies LabDefinition;
