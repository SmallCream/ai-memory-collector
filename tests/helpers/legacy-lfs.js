// Historical pointer fixture only; the extension no longer implements LFS.
export const formatLfsPointer = ({ oid, size }) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
