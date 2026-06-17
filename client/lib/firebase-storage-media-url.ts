const FIREBASE_MEDIA_OBJECT_PATH = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/;

function firebaseMediaUrl(bucket: string, objectKey: string): string {
  const key = objectKey.replace(/^\/+/, "").replace(/\\/g, "/");
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(key)}?alt=media`;
}

function copyFirebaseTokenSearchParam(fromUrl: URL, onto: URL): void {
  const tok = fromUrl.searchParams.get("token");
  if (tok !== null && tok !== "") onto.searchParams.set("token", tok);
}

/**
 * Given a **master** playlist URL in Firebase Storage REST form
 * (`…/v0/b/{bucket}/o/{encodeURIComponent(objectPath)}?alt=media`), build the URL for another object
 * in the same folder (`stream_0.m3u8`, etc.). Returns **`null`** if `masterManifestUrl` is not that shape.
 */
export function firebaseStorageSiblingUriFromMaster(
  masterManifestUrl: string,
  siblingLeaf: string,
): string | null {
  try {
    const u = new URL(masterManifestUrl);
    const m = u.pathname.match(FIREBASE_MEDIA_OBJECT_PATH);
    if (!m || !m[1] || !m[2]) return null;
    const bucket = decodeURIComponent(m[1]);
    const encodedObject = m[2];
    const objectKey = decodeURIComponent(encodedObject.replace(/\+/g, " "));
    const slash = objectKey.lastIndexOf("/");
    const dir = slash >= 0 ? objectKey.slice(0, slash) : "";
    const nextKey = dir ? `${dir}/${siblingLeaf}` : siblingLeaf;
    const baseOut = firebaseMediaUrl(bucket, nextKey);
    const nu = new URL(baseOut);
    copyFirebaseTokenSearchParam(u, nu);
    return nu.href;
  } catch {
    return null;
  }
}
