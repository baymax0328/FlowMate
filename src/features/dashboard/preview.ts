import type { Json } from '../../api/hooks';

// 仅用于展示的假数据：不发给任何接口，也不会写成业务记录。
export function dashboardPreview(period: string, team: boolean): Json {
  const factor = team ? 4 : 1;
  const count = period === 'day' ? 1 : period === 'month' ? 30 : 7;
  const now = new Date();
  const series = Array.from({ length: count }, (_, i) => {
    const day = new Date(now); day.setDate(day.getDate() - count + i + 1);
    return { created: [3, 5, 2, 6, 4, 2, 5][i % 7] * factor, token: [8200, 12300, 7400, 15600, 9200, 6600, 10800][i % 7] * factor, label: `${day.getMonth() + 1}/${day.getDate()}`, done: [2, 4, 3, 5, 2, 1, 3][i % 7] * factor, online: [330, 372, 288, 210, 305, 90, 180][i % 7] };
  });
  return {
    kpi: { active: 12 * factor, phases: { create: 2 * factor, receive: 3 * factor, work: 5 * factor, review: 2 * factor }, token: { total: 86400 * factor, in: 57600 * factor, out: 28800 * factor }, avg: { hours: 3.2, target: 4 }, completion: { overdueDone: 0, onTime: 15 * factor, atRisk: 2 * factor, overdue: factor, accepted: 15 * factor, total: 18 * factor, pct: 83 } },
    series,
    gallery: ['产品需求评审纪要', '客户调研分析报告', '季度运营方案', '协作流程设计'].map((task, i) => ({ id: `preview-${i}`, task, files: [`${task}.${['pdf','docx','xlsx','pptx'][i]}`], desc: ['决策清单与下一步安排', '访谈结论与改进建议', '目标拆解与执行计划', '流程规范与交接说明'][i], accepted: i !== 2, fileCount: i + 2, who: `示例成员 ${i + 1}`, team: '产品协作组', at: now.toISOString() })),
    projects: ['产品体验优化', '知识库建设', '客户服务升级'].map((project, i) => ({ project, done: [8, 5, 3][i], total: 10, pct: [80, 50, 30][i] })),
    relay: ['需求说明交接', '调研报告复核', '上线方案确认', '客户门户联调', '协作流程验收'].map((task, i) => ({
      task, from_id: `example-${i}`, to_id: `example-${i+1}`,
      from: `示例成员 ${i + 1}`, to: `示例成员 ${i + 2}`,
      from_avatar: ['male-1','female-1','male-2','female-2','male-3'][i],
      to_avatar: ['female-1','male-2','female-2','male-3','female-3'][i],
      processingMs: [1800000, 4320000, 7200000, 5400000, 9900000][i],
      status: ['in_progress','completed','pending_accept','in_progress','completed'][i],
    })),
    workload: [10, 8, 6, 5, 3, 4, 2].map((total, i) => ({ id: `preview-${i}`, name: `示例成员 ${i + 1}`, total, completed: Math.max(0,total-2) })),
    workloadDepartments: [15, 13, 10].map((total, i) => ({ id: `team-${i}`, name: ['产品团队','研发团队','设计团队'][i], total, completed: [10,8,6][i] })),
  };
}

