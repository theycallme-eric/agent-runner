export interface ProjectRegistration {
  id: string;
  rootPath: string;
  contractPath: string;
  workerProfile: string;
  enabled: boolean;
  contractVersion: number;
  registeredAt: number;
  updatedAt: number;
}

export interface RegisterProjectRequest {
  id: string;
  rootPath: string;
  contractPath: string;
  workerProfile: string;
  contractVersion: number;
  now: number;
}

export type RegisterProjectResult =
  | { created: true; project: ProjectRegistration }
  | { created: false; project: ProjectRegistration };
