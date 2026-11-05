// GitHub I/O only: the narrow slice of Octokit this action uses, so tests mock exactly this.
// No clone of the customer repository; every read is a REST call made with the job's GITHUB_TOKEN.
export interface Repo {
  owner: string
  repo: string
}

export interface Gh {
  rest: {
    search: {
      issuesAndPullRequests(p: { q: string; per_page: number; sort?: 'created'; order?: 'asc' }): Promise<{
        data: { total_count: number; items: Array<{ number: number; labels: Array<string | { name?: string }> }> }
      }>
    }
    actions: {
      listWorkflowRuns(p: Repo & { workflow_id: string; head_sha: string; per_page: number }): Promise<{
        data: { workflow_runs: Array<{ status: string | null; conclusion: string | null; event: string }> }
      }>
      createWorkflowDispatch(
        p: Repo & { workflow_id: string; ref: string; inputs?: Record<string, string> }
      ): Promise<unknown>
    }
    git: {
      getRef(p: Repo & { ref: string }): Promise<{ data: { object: { sha: string } } }>
    }
    issues: {
      addLabels(p: Repo & { issue_number: number; labels: string[] }): Promise<unknown>
      removeLabel(p: Repo & { issue_number: number; name: string }): Promise<unknown>
    }
  }
}

export const labelNames = (labels: Array<string | { name?: string }>): string[] =>
  labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)

export interface ReadyPr {
  number: number
  labels: string[]
}

/** ONE search call: open, non-draft PRs carrying `label`, oldest first (first 100). */
export async function listReady(gh: Gh, r: Repo, label: string): Promise<{ prs: ReadyPr[]; total: number }> {
  const q = `repo:${r.owner}/${r.repo} is:pr is:open draft:false label:"${label.replace(/"/g, '\\"')}"`
  const { data } = await gh.rest.search.issuesAndPullRequests({ q, per_page: 100, sort: 'created', order: 'asc' })
  return { prs: data.items.map((i) => ({ number: i.number, labels: labelNames(i.labels) })), total: data.total_count }
}

/** True when a dispatched run for this head SHA is queued, running or green. */
export async function hasRunForSha(gh: Gh, r: Repo, workflow: string, sha: string): Promise<boolean> {
  const { data } = await gh.rest.actions.listWorkflowRuns({ ...r, workflow_id: workflow, head_sha: sha, per_page: 20 })
  return data.workflow_runs.some(
    (w) => w.event === 'workflow_dispatch' && (w.status !== 'completed' || w.conclusion === 'success')
  )
}

/** A dispatch takes a ref, not a SHA: refuse when the branch moved past the SHA this event saw. */
export async function branchTip(gh: Gh, r: Repo, branch: string): Promise<string> {
  const { data } = await gh.rest.git.getRef({ ...r, ref: `heads/${branch}` })
  return data.object.sha
}

export const dispatch = (gh: Gh, r: Repo, workflow: string, ref: string, inputs: Record<string, string>) =>
  gh.rest.actions.createWorkflowDispatch({ ...r, workflow_id: workflow, ref, inputs })

export const addLabel = (gh: Gh, r: Repo, n: number, label: string) =>
  gh.rest.issues.addLabels({ ...r, issue_number: n, labels: [label] })

export async function removeLabel(gh: Gh, r: Repo, n: number, label: string): Promise<void> {
  try {
    await gh.rest.issues.removeLabel({ ...r, issue_number: n, name: label })
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err
  }
}

export const httpStatus = (err: unknown): number | undefined => (err as { status?: number } | null)?.status
