import { UserRoundCheck } from 'lucide-react';
import { STATIC_MODE } from '../../../shared/runtime';
import type { LabDefinition } from '../types';

export default {
  id: 'human-approval',
  title: '人工确认与业务事实',
  description: '修改并确认一条报名提议，验证版本绑定、幂等写入与响应中断后的事实查询。',
  topicIds: ['human-in-the-loop', 'proposal-version', 'idempotency', 'authoritative-state'],
  protocols: [],
  protocolVersions: {},
  order: 60,
  status: 'available',
  modes: ['local', 'pages'],
  docs: 'labs/human-approval',
  sourceReferences: [
    'shared/labs/human-approval/engine.ts',
    'shared/labs/human-approval/ports.ts',
    'server/labs/human-approval/store.ts',
    'server/labs/human-approval/routes.ts',
    'src/labs/human-approval/Lab.tsx',
  ],
  presentation: {
    name: '人工确认与业务事实',
    subtitle: '让确认绑定到具体内容',
    label: '提议 · 决策 · 业务记录',
    description: '一条本地报名记录，串起修改、审批、幂等执行和权威事实查询。',
    icon: UserRoundCheck,
    color: 'amber',
    transport: STATIC_MODE ? '浏览器内 · 审批模拟' : 'HTTP · SQLite',
    steps: ['生成提议', '修改并核对版本', '确认或拒绝', '查询报名事实'],
    question: '点击“确认”后，怎样知道业务记录真的写入了？',
    explanation:
      '提议内容、内容版本、教学会话和有效期共同限定一次确认。服务端在同一事务内校验命令、更新提议并写入报名记录。响应丢失时结果仍可能已提交，先查事实，再决定是否用原命令重试。',
    concepts: [
      ['确认具体内容', '修改会产生新版本；旧页面、旧命令和过期确认不能授权另一份内容。'],
      ['命令幂等', '同一 commandId 的相同请求重放原结果；同键异参明确冲突，报名只写入一次。'],
      ['事实与反馈分开', '按钮点击与请求发送属于客户端状态，查询到报名记录才是写入证据。'],
    ],
    exercise:
      '修改报名人数后尝试旧版本确认，再模拟丢失确认响应。查询事实后重放原命令，检查报名记录数量与版本，解释“明确失败”和“结果未知”的恢复差别。',
  },
  load: () => import('./Lab'),
} satisfies LabDefinition;
