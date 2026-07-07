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
  /** Tipo de fuente: "image" (registry/docker) o "git" (repo). */
  sourceType?: "image" | "git" | "docker-compose";
  /** Repo URL si viene de git. */
  repository?: string;
  /** Branch a deployar. */
  branch?: string;
  /** Commit SHA actual del repo. */
  commit?: string;
  /** Path dentro del repo (para monorepos). */
  buildPath?: string;
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
