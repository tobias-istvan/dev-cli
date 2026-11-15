/**
 * The plugin interface.
 *
 * A plugin knows one vendor, like GitHub or Atlassian, and owns its login. It offers one
 * or more services, like Jira and Confluence, which a project enables one by one. Each
 * service implements the capabilities that apply to it; only `id`, `title`, `role` and
 * `scope` are required.
 *
 * Plugins never touch the home config or the workspace's shared files directly. They get
 * what they need through the contexts below, so the core can keep credentials out of the
 * workspace and keep every generated file consistent.
 */

// ---------------------------------------------------------------------------
// Shared shapes

/** Whether a command only reads, or changes something in a service. */
export type Mark = "read" | "change";

/** One credential set for one account, as the plugin's login returned it. */
export type Credentials = Record<string, string>;

/** A service's scope, as saved under its entry in dev.yaml. The service defines the shape. */
export type Scope = Record<string, unknown>;

/** A problem found by a check, with what to do about it. */
export interface Problem {
  message: string;
  fix?: string;
}

export interface Output {
  info(message: string): void;
  warn(message: string): void;
  /** What's happening while someone waits, for agents, scripts and logs. Leave it out for none. */
  progress?(message: string): void;
}

// ---------------------------------------------------------------------------
// Contexts the core passes in

export interface PluginContext {
  /** The workspace root, or null when there is no workspace yet (during init). */
  root: string | null;
  out: Output;
  /** Whether a person is at a terminal, so prompts may be shown. */
  interactive: boolean;
}

/** How a service syncs and fetches, from its entry in dev.yaml. */
export interface ServiceSettings {
  /** "within-scope" (the default) never fetches items outside the scope; "anywhere" follows any link. */
  fetch: "within-scope" | "anywhere";
  /** "full" syncs the whole scope; "referenced" keeps only what tasks point to up to date. */
  sync: "full" | "referenced";
}

export interface ServiceContext extends PluginContext {
  /** Core batches mirror writes and rebuilds the index once at the end. */
  deferIndex?: boolean;
  /** Files fetched during this command, avoiding duplicate task-context requests. */
  fetched?: Map<string, string>;
  root: string;
  settings: ServiceSettings;
  /** This service's folder, like <root>/jira. Versioning services have none. */
  folder: string | null;
  scope: Scope;
  /** The saved credentials for this plugin. Throws a clear error when not logged in. */
  credentials(): Credentials;
  /**
   * Finds references to other enabled services' items in text, like a ticket key in a
   * PR's title, and fetches the ones not already in the workspace. Returns each with its
   * file relative to the workspace root, when it could be fetched.
   */
  references(text: string): Promise<Array<{ reference: Reference; file: string | null; outside?: boolean; command?: string }>>;
  /**
   * An item's body with its links pointed at local copies, wherever they lead to something
   * an enabled service has in the workspace. `file` is where the item will be written.
   * Nothing is fetched. Call it on a body before writing it.
   */
  localize(body: string, file: string): Promise<string>;
  /**
   * How far a long job has got, like "40 of 120 tickets", shown to whoever's waiting. Cheap
   * to call often: it's drawn at most a few times a second, and plain lines are rarer still.
   */
  progress(detail: string): void;
}

// ---------------------------------------------------------------------------
// Plugin level

export interface LoginMethod {
  /** "cli" reuses another tool's login, like gh's, so nothing secret is stored. */
  kind: "oauth" | "token" | "cli";
  /** Shown when choosing between methods, like "Personal access token". */
  title: string;
}

export interface LoginStatus {
  ok: boolean;
  /** The account the credentials belong to, like a username or email. */
  account?: string;
  problem?: Problem;
}

export interface Login {
  methods: LoginMethod[];
  /** The plugin works without a login, doing less. Offered at setup, never required. */
  optional?: { benefit: string };
  /** Asks the person for what the method needs and returns credentials to store. */
  login(
    context: PluginContext,
    method: LoginMethod["kind"],
    options: { account?: string },
  ): Promise<{ account: string; credentials: Credentials }>;
  /** Checks stored credentials still work. Must not change anything. */
  check(context: PluginContext, credentials: Credentials): Promise<LoginStatus>;
  /** Revokes anything on the service side, if the method allows. Stored values are removed by the core. */
  logout?(context: PluginContext, credentials: Credentials): Promise<void>;
}

/** What a plugin's own CLI does, for the command check. */
export interface CommandPolicy {
  /** The executables this plugin understands, like ["gh"]. */
  executables: string[];
  /** Classifies one call: its words after the executable. */
  classify(args: string[]): { command: string; kind: Mark | "unknown"; why: string };
}

export interface Plugin {
  /** Lowercase, used in service ids and command names, like "atlassian". */
  name: string;
  /** Shown to people, like "Atlassian". */
  title: string;
  description: string;
  login: Login;
  services: Service[];
  /** Values to redact from saved sessions, given this plugin's credentials. Tokens at least. */
  secrets?(credentials: Credentials): string[];
  commandPolicy?: CommandPolicy;
}

// ---------------------------------------------------------------------------
// Service level

export type Role = "versioning" | "connected";

export interface ScopeCapability {
  /** One line describing a saved scope, like "board 42, assigned to you". */
  describe(scope: Scope): string;
  /** Lets the person pick a scope, using the service's own lists. */
  choose(context: ServiceContext): Promise<Scope>;
  /** Problems with a saved scope's shape. Must not reach the network. */
  validate(scope: Scope): Problem[];
  /**
   * Adds items to the scope by link or id, like a page someone linked to. Returns the new
   * scope and what it added. Only for services whose scope is a list of things.
   */
  add?(scope: Scope, items: string[]): { scope: Scope; added: string[]; problems: Problem[] };
  remove?(scope: Scope, items: string[]): { scope: Scope; removed: string[]; problems: Problem[] };
}

export interface SyncOptions {
  /** Ignore the saved position and fetch everything in scope. */
  full: boolean;
}

export interface SyncReport {
  added: number;
  updated: number;
  removed: number;
  /** Items that failed. A failure never stops the rest of the run. */
  failed: Array<{ id: string; reason: string }>;
  /** Things the person should know that didn't fail the sync, like a list cut off at its limit. */
  warnings?: string[];
}

export interface Reference {
  /** The service that recognised it, like "atlassian:jira". */
  service: string;
  id: string;
  url?: string;
  /** Recognised by its shape alone, so it may not be a reference at all. Never reported as outside the scope. */
  uncertain?: boolean;
}

export interface LinkCapability {
  /**
   * Every reference to this service's items found in a piece of text. Must be quick and
   * local. The context's scope, and the workspace it gives access to, help tell real
   * references from lookalikes.
   */
  find(text: string, context: ServiceContext): Reference[];
  /** Fetches one referenced item into the service's folder, and returns its file. */
  fetch(context: ServiceContext, reference: Reference): Promise<string>;
  /**
   * The referenced item's file, if it's already in the workspace. Must be quick and local.
   * With it, links to the item in other mirrored files become links to this file.
   */
  local?(context: ServiceContext, reference: Reference): Promise<string | null>;
}

export interface Contributions {
  /** A Markdown section for snapshot.md, or null for nothing to say. */
  snapshot?(context: ServiceContext): Promise<string | null>;
  /** Lines added to the agent's context at session start. Must be fast and local. */
  sessionStart?(context: ServiceContext): Promise<string[]>;
  /** Facts for the day summary, like items changed today. */
  dayEnd?(context: ServiceContext, date: string): Promise<string[]>;
  /** What `dev task start` should know about an item from this service. */
  taskStart?(context: ServiceContext, reference: Reference): Promise<TaskContext>;
}

export interface TaskContext {
  title: string;
  /** Files in the workspace the brief should link to. */
  files: string[];
  /** References to fetch next, like a parent ticket's spec. */
  references: Reference[];
  /** A word for the branch name, like "feature" or "fix". */
  type?: string;
  /** Links outside the scope, which the workspace doesn't fetch. Listed so a person can open them. */
  notFetched?: string[];
}

export interface CommandOption {
  /** Commander syntax, like "--limit <n>" or "--no-index". */
  flags: string;
  description: string;
  default?: string | boolean;
}

export interface ServiceCommand {
  /** The action, like "pull". Run as `dev <service> <name>`. */
  name: string;
  description: string;
  mark: Mark;
  /** Whether it writes workspace files, given its options. Those take the sync lock, so they never overlap a sync. */
  writes?: boolean | ((options: Record<string, unknown>) => boolean);
  /** Commander syntax, like "<id>" or "[ids...]". */
  arguments?: string[];
  options?: CommandOption[];
  /** Longer help, shown after the options. */
  help?: string;
  run(context: ServiceContext, args: string[], options: Record<string, unknown>): Promise<void>;
}

export interface McpEntry {
  name: string;
  /** The server definition, as tools expect it in .mcp.json. */
  server: Record<string, unknown>;
}

export interface AgentFiles {
  /** Skill folders: name, a one-line description for the frontmatter, and the body. */
  skills?: Array<{ name: string; description: string; body: string }>;
  /** Files under docs/, by name, like "jira.md". */
  docs?: Array<{ file: string; content: string }>;
  /** Rules every agent must follow when using this service. */
  rules?: string[];
  gitignore?: string[];
  mcp?: McpEntry[];
}

export interface TaskItem {
  id: string;
  title: string;
  status: string;
  done: boolean;
  /** Assigned to the person running dev. */
  mine: boolean;
  /** In the service's scope, as opposed to fetched because something pointed to it. */
  inScope: boolean;
  /** Why it's in the workspace: scope, parent, linked, pulled or former. */
  via: string;
  /** When it was last synced, as written in its file. */
  synced?: string;
  due?: string;
  /** The item's file, relative to the workspace root. */
  file: string;
  /** Other files that describe the task, like its parent ticket, where specs often live. */
  related?: string[];
}

export interface TasksCapability {
  /** The tasks in scope, from local files only. */
  list(context: ServiceContext): Promise<TaskItem[]>;
}

export interface VersioningCapability {
  /** The repositories the account can see, most recently changed first. */
  listRepositories(context: PluginContext, credentials: Credentials): Promise<Array<{ id: string; description?: string }>>;
  /** Where a repository is cloned from, for messages. */
  cloneUrl(repository: string): string;
  /**
   * Clones into `target`, showing git's own progress. `url` overrides the default, for
   * people who clone over SSH. Credentials must not end up in the clone's config.
   */
  clone(context: PluginContext, credentials: Credentials, repository: string, target: string, url?: string): Promise<boolean>;
}

export interface Service {
  /** Short and lowercase, used for commands and the folder, like "jira". Unique across plugins. */
  id: string;
  title: string;
  description: string;
  role: Role;
  scope: ScopeCapability;
  sync?(context: ServiceContext, options: SyncOptions): Promise<SyncReport>;
  links?: LinkCapability;
  contribute?: Contributions;
  commands?: ServiceCommand[];
  agentFiles?: AgentFiles;
  /** Checks beyond login and scope shape, like a required tool being installed. */
  doctor?(context: ServiceContext): Promise<Problem[]>;
  /** Only for the versioning role. */
  versioning?: VersioningCapability;
  /** For task sources, like Jira: what work there is. Their items drive the reference sweep. */
  tasks?: TasksCapability;
  /**
   * For "referenced" syncing: update the items already in the workspace, without pulling
   * the rest of the scope. New items arrive through the reference sweep.
   */
  refresh?(context: ServiceContext): Promise<SyncReport>;
  /**
   * Where this service's items are and which files they are, for its index.md. A
   * connected service defaults to its own folder and every Markdown file in it.
   */
  index?: { folder: string; title: string; include?: (file: string) => boolean };
}

/** A service together with the plugin that offers it. */
export interface ServiceEntry {
  plugin: Plugin;
  service: Service;
  /** "<plugin>:<service>", like "atlassian:jira". */
  key: string;
}
