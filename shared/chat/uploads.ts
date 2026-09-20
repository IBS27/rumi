export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

export function validImageHeader(
  bytes: Uint8Array,
  contentType: string,
): boolean {
  const text = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  if (contentType === "image/jpeg")
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png")
    return bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10";
  if (contentType === "image/gif")
    return ["GIF87a", "GIF89a"].includes(text(0, 6));
  return (
    contentType === "image/webp" &&
    text(0, 4) === "RIFF" &&
    text(8, 12) === "WEBP"
  );
}
