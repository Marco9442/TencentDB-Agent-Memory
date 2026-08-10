import type { TeamOption } from "./types.js";

export interface NonInteractiveFallbackOptions {
  /** Team already validated from x-team-id, if one was provided. */
  teamId?: string;
  /** Task already validated from x-task-id, if one was provided. */
  taskId?: string;
  /** Configured virtual/default task, when present in the team's task list. */
  defaultTaskId?: string;
  /** The only team-wide Agent allowed as an automatic fallback. */
  agentName: string;
}
export interface NonInteractiveFallbackSelection {
  teamId: string;
  agentId: string;
  taskId: string;
}

/**
 * Resolve a safe automatic binding for a client that cannot answer a form.
 *
 * We require exactly one candidate team, an explicitly valid task or a single
 * unambiguous task, and an Agent whose name matches the configured team-wide
 * fallback. This prevents a missing header from silently selecting a member's
 * private Agent or an arbitrary task in a multi-team/multi-task account.
 */
export function resolveNonInteractiveFallback(
  teams: TeamOption[],
  options: NonInteractiveFallbackOptions,
): NonInteractiveFallbackSelection | undefined {
  const candidateTeams = teams.filter((team) => {
    if (options.teamId && team.team_id !== options.teamId) return false;
    return team.agents.some((agent) => agent.agent_name === options.agentName);
  });
  if (candidateTeams.length !== 1) return undefined;

  const team = candidateTeams[0];
  const agent = team.agents.find((item) => item.agent_name === options.agentName);
  if (!agent) return undefined;

  const taskId = options.taskId
    ?? (options.defaultTaskId && team.tasks.some((task) => task.task_id === options.defaultTaskId)
      ? options.defaultTaskId
      : undefined)
    ?? (team.tasks.length === 1 ? team.tasks[0].task_id : undefined);
  if (!taskId || !team.tasks.some((task) => task.task_id === taskId)) return undefined;

  return { teamId: team.team_id, agentId: agent.agent_id, taskId };
}
