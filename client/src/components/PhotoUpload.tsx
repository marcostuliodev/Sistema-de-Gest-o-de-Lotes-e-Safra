import { useState, useRef, useEffect, useCallback } from "react";
import { Button, Modal } from "./ui";
import { Camera, Trash, X, Image } from "./icons";
import {
  uploadPhoto,
  getPlantioPhotos,
  deletePhoto,
  getPhotoUrl,
  type Photo,
} from "../db/photos";

interface PhotoUploadProps {
  plantioId: string;
  loteId: string;
  open: boolean;
  onClose: () => void;
  maxFotos: number;
}

export function PhotoUpload({
  plantioId,
  loteId,
  open,
  onClose,
  maxFotos,
}: PhotoUploadProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const loadPhotos = useCallback(async () => {
    if (!plantioId) return;
    setLoading(true);
    try {
      const data = await getPlantioPhotos(plantioId);
      setPhotos(data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [plantioId]);

  useEffect(() => {
    if (open) {
      loadPhotos();
      setPreview(null);
      setSelectedFile(null);
      setError("");
    }
  }, [open, loadPhotos]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      setError("Arquivo excede o limite de 5MB");
      return;
    }

    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      setError("Tipo não permitido. Use JPEG, PNG ou WebP.");
      return;
    }

    setSelectedFile(file);
    setError("");

    const reader = new FileReader();
    reader.onload = (ev) => setPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  }

  async function handleUpload() {
    if (!selectedFile) return;

    if (maxFotos !== Infinity && photos.length >= maxFotos) {
      setError(`Limite de ${maxFotos} fotos atingido.`);
      return;
    }

    setUploading(true);
    setProgress(0);
    setError("");

    try {
      const photo = await uploadPhoto(plantioId, loteId, selectedFile, setProgress);
      setPhotos((prev) => [photo, ...prev]);
      setPreview(null);
      setSelectedFile(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Excluir esta foto?")) return;
    setDeleting(id);
    try {
      await deletePhoto(id);
      setPhotos((prev) => prev.filter((p) => p._id !== id));
    } catch {
      // silent
    } finally {
      setDeleting(null);
    }
  }

  function cancelPreview() {
    setPreview(null);
    setSelectedFile(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  const limitLabel =
    maxFotos === Infinity ? "Ilimitado" : `${photos.length}/${maxFotos}`;

  return (
    <Modal open={open} onClose={onClose} title="Fotos do Plantio" wide>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-stone-500">
            <Image className="mr-1 inline-block h-4 w-4" />
            {limitLabel} fotos
          </span>
          {maxFotos === 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
              Upgrade necessário
            </span>
          )}
        </div>

        {maxFotos > 0 && (
          <div className="rounded-xl border border-dashed border-stone-300 bg-stone-50 p-4">
            {preview ? (
              <div className="space-y-3">
                <div className="relative mx-auto max-h-48 overflow-hidden rounded-lg">
                  <img
                    src={preview}
                    alt="Preview"
                    className="mx-auto max-h-48 rounded-lg object-contain"
                  />
                  <button
                    onClick={cancelPreview}
                    className="absolute right-1 top-1 rounded-full bg-black/50 p-1 text-white hover:bg-black/70"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {uploading && (
                  <div className="w-full">
                    <div className="mb-1 flex justify-between text-xs text-stone-500">
                      <span>Enviando...</span>
                      <span>{progress}%</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-stone-200">
                      <div
                        className="h-full rounded-full bg-green-600 transition-all duration-300"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="subtle" onClick={cancelPreview} disabled={uploading}>
                    Cancelar
                  </Button>
                  <Button onClick={handleUpload} disabled={uploading}>
                    <Camera className="h-4 w-4" />
                    {uploading ? "Enviando..." : "Enviar foto"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <div className="grid w-full grid-cols-2 gap-2">
                  <Button variant="subtle" onClick={() => cameraRef.current?.click()}>
                    📷 Tirar foto
                  </Button>
                  <Button variant="subtle" onClick={() => fileRef.current?.click()}>
                    🖼️ Galeria
                  </Button>
                </div>
                <label className="flex cursor-pointer flex-col items-center gap-2">
                  <Camera className="h-8 w-8 text-stone-400" />
                  <span className="text-sm font-medium text-stone-600">
                    Toque para selecionar uma foto
                  </span>
                  <span className="text-xs text-stone-400">
                    JPEG, PNG ou WebP · Máx. 5MB
                  </span>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </label>
                {/* Câmera — abre a câmera traseira direto no celular */}
                <input
                  ref={cameraRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {loading ? (
          <div className="flex justify-center py-8">
            <span className="text-sm text-stone-400">Carregando fotos...</span>
          </div>
        ) : photos.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {photos.map((photo) => (
              <div
                key={photo._id}
                className="group relative overflow-hidden rounded-xl border border-stone-200"
              >
                <img
                  src={getPhotoUrl(photo._id)}
                  alt={photo.filename}
                  className="aspect-square w-full object-cover"
                  loading="lazy"
                />
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                  <p className="truncate text-xs text-white">{photo.filename}</p>
                </div>
                <button
                  onClick={() => handleDelete(photo._id)}
                  disabled={deleting === photo._id}
                  className="absolute right-1 top-1 rounded-full bg-black/50 p-1 text-white opacity-0 transition-opacity hover:bg-red-600 group-hover:opacity-100"
                  title="Excluir"
                >
                  {deleting === photo._id ? (
                    <span className="block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  ) : (
                    <Trash className="h-4 w-4" />
                  )}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center py-8 text-center">
            <Image className="mb-2 h-10 w-10 text-stone-300" />
            <p className="text-sm text-stone-500">Nenhuma foto registrada</p>
            <p className="text-xs text-stone-400">
              Adicione fotos para acompanhar a evolução do plantio.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
