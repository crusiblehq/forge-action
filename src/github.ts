import { PolicyError } from './policy/index.js'

// GitHub I/O only: the narrow slice of Octokit this action uses, so tests mock exactly this.
// No clone of the customer repository; every read is a REST or GraphQL call made with the job's GITHUB_TOKEN.
export interface Repo {
  owner: string
  repo: string
}

export interface Gh {
  graphql<T>(query: string, vars: Record<string, unknown>): Promise<T>
  rest: {
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

const READY_QUERY = `query($owner: String!, $repo: String!, $label: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, labels: [$label], first: 100, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes { number isDraft labels(first: 50) { nodes { name } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

interface ReadyPage {
  repository: {
    pullRequests: {
      nodes: Array<{ number: number; isDraft: boolean; labels: { nodes: Array<{ name: string }> } }>
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
    }
  }
}

export const MAX_PAGES = 5

/** Open, non-draft PRs carrying `label` (SPEC 3.2.3), read from GraphQL, which is not an index: no search lag. Paged. */
export async function listReady(gh: Gh, r: Repo, label: string): Promise<ReadyPr[]> {
  const out: ReadyPr[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: ReadyPage = await gh.graphql<ReadyPage>(READY_QUERY, { owner: r.owner, repo: r.repo, label, after })
    const prs = data.repository.pullRequests
    for (const n of prs.nodes) {
      if (!n.isDraft) out.push({ number: n.number, labels: n.labels.nodes.map((l) => l.name) })
    }
    if (!prs.pageInfo.hasNextPage) return out.sort((a, b) => a.number - b.number)
    after = prs.pageInfo.endCursor
  }
  throw new Error(`more than ${MAX_PAGES * 100} open pull requests carry "${label}"`)
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
  try {
    const { data } = await gh.rest.git.getRef({ ...r, ref: `heads/${branch}` })
    return data.object.sha
  } catch (err) {
    const s = httpStatus(err)
    if (s === 403 || s === 404) {
      throw new PolicyError(`branch read refused (HTTP ${s}): grant the job "contents: read" in permissions`)
    }
    throw err
  }
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

/** A rate limit (primary or secondary), as opposed to a refusal: retry it, never fail the step on it. */
export function isRateLimit(err: unknown): boolean {
  const e = err as {
    status?: number
    message?: string
    response?: { headers?: Record<string, string | number | undefined> }
    errors?: Array<{ type?: string }>
  } | null
  if (!e) return false
  if (e.errors?.some((x) => x.type === 'RATE_LIMITED')) return true
  if (e.status === 429) return true
  if (e.status !== 403) return false
  const h = e.response?.headers ?? {}
  return (
    String(h['x-ratelimit-remaining']) === '0' || h['retry-after'] !== undefined || /rate limit/i.test(e.message ?? '')
  )
}

/** A permission or scope refusal: GraphQL reports it as errors[].type on a 200, REST as 401/403/404/422. */
export function isPermissionError(err: unknown): boolean {
  const e = err as { errors?: Array<{ type?: string }> } | null
  if (e?.errors?.some((x) => x.type === 'FORBIDDEN' || x.type === 'INSUFFICIENT_SCOPES')) return true
  const s = httpStatus(err)
  return s === 401 || s === 403 || s === 404 || s === 422
}
