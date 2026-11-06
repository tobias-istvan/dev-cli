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

export interface ServiceContext extends PluginContext {
  root: string;
  /** This service's folder, like <root>/jira. Versioning services have none. */
  folder: string | null;
  scope: Scope;
  /** The saved credentials for this plugin. Throws a clear error when not logged in. */
  credentials(): Credentials;
}

// ---------------------------------------------------------------------------
// Plugin level

export interface LoginMethod {
  kind: "oauth" | "token";
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
  /** Asks the person for what the method needs and returns credentials to store. */
  login(context: PluginContext, method: LoginMethod["kind"]): Promise<{ account: string; credentials: Credentials }>;
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
}

export interface Reference {
  /** The service that recognised it, like "atlassian:jira". */
  service: string;
  id: string;
  url?: string;
}

export interface LinkCapability {
  /** Every reference to this service's items found in a piece of text. */
  find(text: string): Reference[];
  /** Fetches one referenced item into the service's folder, and returns its file. */
  fetch(context: ServiceContext, reference: Reference): Promise<string>;
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

export interface VersioningCapability {
  listRepositories(context: PluginContext, credentials: Credentials): Promise<Array<{ id: string; description?: string }>>;
  cloneUrl(repository: string): string;
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
}

/** A service together with the plugin that offers it. */
export interface ServiceEntry {
  plugin: Plugin;
  service: Service;
  /** "<plugin>:<service>", like "atlassian:jira". */
  key: string;
}
