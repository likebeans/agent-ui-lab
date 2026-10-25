import { History } from 'lucide-react';
import { PROTOCOL_VERSION } from '@ag-ui/core';
import { STATIC_MODE } from '../../../shared/runtime';
import type { LabDefinition } from '../types';

export default {
  id: 'task-recovery',
  title: '任务恢复与事件重放',
  description: '断开连接、刷新恢复、取消与重新执行：对照服务端任务和 AG-UI 事件投影。',
  topicIds: ['task-recovery', 'event-replay', 'checkpoint', 'run-identity'],
  protocols: ['agui'],
  protocolVersions: { agui: PROTOCOL_VERSION },
  order: 50,
  status: 'available',
  modes: ['local', 'pages'],
  docs: 'labs/task-recovery',
  sourceReferences: [
    'shared/labs/task-recovery/contract.ts',
    'shared/labs/task-recovery/engine.ts',
    'shared/labs/task-recovery/client.ts',
    'shared/labs/task-recovery/memory.ts',
    'server/labs/task-recovery/store.ts',
    'src/labs/task-recovery/useRecoverySession.ts',
    'src/labs/task-recovery/Lab.tsx',
  ],
  presentation: {
    name: '任务恢复与事件重放',
    subtitle: '任务独立执行，界面按记录恢复',
    label: '持久任务 · checkpoint · AG-UI',
    description: '创建确定性任务，断开接流后查询，再用 checkpoint 和连续事件重建界面。',
    icon: History,
    color: 'teal',
    transport: STATIC_MODE ? 'memory-fixture · 刷新清空' : 'HTTP · SSE · SQLite',
    steps: ['创建与启动任务', '断开接流', '查询与重放恢复', '验证重复与旧 run'],
    question: '浏览器断开后，怎样知道任务是否还在执行？',
    explanation:
      '任务状态由服务端维护，SSE 只是接收记录的连接。恢复读取同一快照中的 checkpoint 与后续事件，按 task、run 和 seq 校验连续性。断连不等于取消，重新执行产生新 run，重放不会再次调用工具。Pages 用刷新清空的内存样本演示同一接口。',
    concepts: [
      [
        '任务与连接分开',
        '关闭 AbortController 仅停止接流；取消命令必须由服务端确认，任务可能在断连时继续完成。',
      ],
      [
        '重放与执行分开',
        '恢复只读取 checkpoint 与已有记录。toolExecutionCount 对照本地工具记录，不承诺外部副作用 exactly-once。',
      ],
      [
        '身份与载荷分开',
        'taskId、runId、seq 是应用 envelope；原始 AG-UI payload 经官方 schema 校验后保留在 trace.payload。',
      ],
    ],
    exercise:
      '运行任务后断开接流，稍后查询再恢复。比较 cursor 与工具计数，然后重新执行，投递一次旧 run 事件。',
  },
  load: () => import('./Lab'),
} satisfies LabDefinition;
