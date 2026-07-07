// Tipos compartidos.

export type Connection = {
  url: string;
  apiKey: string;
};

export type ProjectSummary = {
  projectId: string;
  name: string;
  description?: string;
};

export type ServiceKind = "app" | "db" | "compose" | "unknown";

export type ServiceSummary = {
  id: string;
  name: string;
  /** Slug interno del service (appName) tal como Dokploy lo nombra en docker. */
  appName?: string;
  kind: ServiceKind;
  status?: string;
  volumeName?: string;
  databaseType?: DatabaseType;
  image?: string;
  /** Dokploy environmentId al que pertenece este service. */
  envId?: string;
  /** Dokploy projectId al que pertenece este service. */
  projectId?: string;
  // -------- Source (git / image / compose) --------
  /** Tipo de fuente: "image" | "git" | "docker-compose" */
  sourceType?: "image" | "git" | "docker-compose";
  /** Provider del source git (github, gitlab, bitbucket, gitea, docker, git) */
  sourceProvider?: string;
  /** ID de la cuenta de github/gitlab/etc. conectada en Dokploy */
  sourceAccountId?: string;
  /** Repo URL si viene de git. */
  repository?: string;
  /** Branch a deployar. */
  branch?: string;
  /** Commit SHA actual del repo. */
  commit?: string;
  /** Path dentro del repo (para monorepos). */
  buildPath?: string;
  /** Trigger: "push" | "tag" | "manual" */
  triggerType?: string;
  /** Watch paths (array de globs). */
  watchPaths?: string[];
  /** Si el repo tiene submodules. */
  enableSubmodules?: boolean;
  // -------- Build --------
  /** Tipo de build: "dockerfile" | "railpack" | "nixpacks" | "heroku" | "paketo" | "static" */
  buildType?: string;
  /** Path al Dockerfile dentro del repo (default "Dockerfile") */
  dockerfile?: string;
  /** Docker context path (default ".") */
  dockerContextPath?: string;
  /** Stage especifico en multi-stage Dockerfile */
  dockerBuildStage?: string;
  /** Volumenes declarados por Dokploy para este servicio (de la API). */
  mounts?: Array<{ name: string; destination: string; type: "bind" | "volume" }>;
};

export type DatabaseType = "postgres" | "mysql" | "mariadb" | "mongo" | "redis";

export type BackupSelection = {
  compose: boolean;
  env: boolean;
  volumes: boolean;
  database: boolean;
};

export type ServiceBackupPlan = {
  service: ServiceSummary;
  selection: BackupSelection;
};

export type BackupPlan = {
  project: ProjectSummary;
  services: ServiceBackupPlan[];
  bundleName: string;
  generatedAt: string;
};
