import { getActiveScope } from "./db";

export interface Photo {
  _id: string;
  user_id?: string;
  plantio_id: string;
  lote_id: string;
  filename: string;
  mimetype: string;
  size: number;
  gridfs_id?: string;
  created_at: string;
}

const API = "/api/photos";

function projectId(): string {
  const scope = getActiveScope();
  if (!scope) throw new Error("Projeto não selecionado");
  return scope.projectId;
}

function withProjectHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set("X-Project-Id", projectId());
  return result;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = withProjectHeaders(options.headers);
  const res = await fetch(path, { ...options, headers, credentials: "include" });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("agrolote:logout"));
    throw new Error("Sessão expirada");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Erro ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export async function uploadPhoto(
  plantioId: string,
  loteId: string,
  file: File,
  onProgress?: (pct: number) => void
): Promise<Photo> {
  const formData = new FormData();
  formData.append("photo", file);
  formData.append("plantio_id", plantioId);
  formData.append("lote_id", loteId);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", API);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Project-Id", projectId());

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        try {
          const data = JSON.parse(xhr.responseText);
          reject(new Error(data.error || `Erro ${xhr.status}`));
        } catch {
          reject(new Error(`Erro ${xhr.status}`));
        }
      }
    };

    xhr.onerror = () => reject(new Error("Erro de rede"));
    xhr.send(formData);
  });
}

export async function getPlantioPhotos(plantioId: string): Promise<Photo[]> {
  return request<Photo[]>(`${API}?plantio_id=${encodeURIComponent(plantioId)}`);
}

export async function getLotePhotos(loteId: string): Promise<Photo[]> {
  return request<Photo[]>(`${API}?lote_id=${encodeURIComponent(loteId)}`);
}

export async function deletePhoto(id: string): Promise<void> {
  await request<void>(`${API}/${id}`, { method: "DELETE" });
}

export function getPhotoUrl(photoId: string): string {
  return `${API}/${encodeURIComponent(photoId)}/file?project_id=${encodeURIComponent(projectId())}`;
}

export async function fetchPhotoUrl(photoId: string): Promise<string> {
  const res = await fetch(`${API}/${photoId}/file`, {
    headers: withProjectHeaders(),
    credentials: "include",
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("agrolote:logout"));
    throw new Error("Sessão expirada");
  }
  if (!res.ok) throw new Error(`Erro ${res.status}`);
  return URL.createObjectURL(await res.blob());
}
