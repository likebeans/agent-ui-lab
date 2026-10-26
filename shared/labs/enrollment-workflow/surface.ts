import {
  A2UI_BASIC_CATALOG_ID,
  A2UI_VERSION,
  a2uiClientActionSchema,
  type A2uiMessage,
} from '../../a2ui';
import { WORKSHOPS, type ApprovalCommand, type ApprovalTask } from '../human-approval/types';

export const WORKFLOW_SURFACE = 'enrollment-workflow-form';

export function workflowForm(task: ApprovalTask | null, taskId: string): A2uiMessage[] {
  const input = task?.state.proposal.content ?? {
    attendeeName: '示例学员',
    workshopId: WORKSHOPS[0].id,
    seats: 1,
  };
  return [
    {
      version: A2UI_VERSION,
      createSurface: { surfaceId: WORKFLOW_SURFACE, catalogId: A2UI_BASIC_CATALOG_ID },
    },
    {
      version: A2UI_VERSION,
      updateDataModel: {
        surfaceId: WORKFLOW_SURFACE,
        path: '/',
        value: {
          taskId,
          version: task?.version ?? 0,
          form: {
            attendeeName: input.attendeeName,
            workshopId: [input.workshopId],
            seats: String(input.seats),
          },
        },
      },
    },
    {
      version: A2UI_VERSION,
      updateComponents: {
        surfaceId: WORKFLOW_SURFACE,
        components: [
          { id: 'root', component: 'Card', child: 'fields' },
          {
            id: 'fields',
            component: 'Column',
            children: ['title', 'attendeeName', 'workshopId', 'seats', 'submit'],
          },
          { id: 'title', component: 'Text', text: '活动报名需求', variant: 'h2' },
          {
            id: 'attendeeName',
            component: 'TextField',
            label: '报名姓名',
            value: { path: '/form/attendeeName' },
          },
          {
            id: 'workshopId',
            component: 'ChoicePicker',
            label: '工作坊',
            variant: 'mutuallyExclusive',
            options: WORKSHOPS.map(({ id, title }) => ({ label: title, value: id })),
            value: { path: '/form/workshopId' },
          },
          {
            id: 'seats',
            component: 'TextField',
            label: '报名人数',
            value: { path: '/form/seats' },
          },
          {
            id: 'submit-label',
            component: 'Text',
            text: task ? '保存修改并重新核对' : '生成待确认提议',
          },
          {
            id: 'submit',
            component: 'Button',
            child: 'submit-label',
            action: {
              event: {
                name: 'prepare_enrollment',
                context: {
                  taskId: { path: '/taskId' },
                  version: { path: '/version' },
                  attendeeName: { path: '/form/attendeeName' },
                  workshopId: { path: '/form/workshopId' },
                  seats: { path: '/form/seats' },
                },
              },
            },
          },
        ],
      },
    },
  ];
}

/** A protocol action carries values; the business engine still validates every field and version. */
export function actionMatchesCommand(input: unknown, command: ApprovalCommand): boolean {
  const action = a2uiClientActionSchema.safeParse(input);
  if (!action.success) return false;
  const payload = command.payload;
  if (payload.type !== 'propose' && payload.type !== 'edit') return false;
  const { context } = action.data.action;
  return (
    action.data.action.surfaceId === WORKFLOW_SURFACE &&
    action.data.action.sourceComponentId === 'submit' &&
    action.data.action.name === 'prepare_enrollment' &&
    context.taskId === command.taskId &&
    context.version === command.expectedVersion &&
    context.attendeeName === payload.input.attendeeName &&
    Array.isArray(context.workshopId) &&
    context.workshopId.length === 1 &&
    context.workshopId[0] === payload.input.workshopId &&
    typeof context.seats === 'string' &&
    context.seats.trim().length > 0 &&
    Number(context.seats) === payload.input.seats
  );
}
