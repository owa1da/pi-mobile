#include "PiSshCore.hpp"
// PiSsh: choose CocoaPod framework or portable OpenSSL headers.
#include "PiSshOpenSSL.h"
#include PISSH_OPENSSL_HEADER(crypto.h)
#include PISSH_OPENSSL_HEADER(evp.h)
#include PISSH_OPENSSL_HEADER(rand.h)
#include PISSH_OPENSSL_HEADER(sha.h)
#include <array>
#include <cstdint>
#include <limits>

namespace pissh {
namespace {
std::string base64(const std::string &bytes) {
  std::string result(4 * ((bytes.size() + 2) / 3), '\0');
  // EVP_EncodeBlock also writes a terminator; std::string reserves it.
  EVP_EncodeBlock(reinterpret_cast<unsigned char *>(result.data()),
                  reinterpret_cast<const unsigned char *>(bytes.data()),
                  static_cast<int>(bytes.size()));
  return result;
}
void u32(std::string &out, uint32_t value) {
  for (int shift = 24; shift >= 0; shift -= 8) out += static_cast<char>(value >> shift);
}
void field(std::string &out, const std::string &value) {
  u32(out, static_cast<uint32_t>(value.size()));
  out += value;
}
struct Secret {
  std::string value;
  ~Secret() { if (!value.empty()) OPENSSL_cleanse(value.data(), value.size()); }
};
} // namespace
std::string fingerprint(const std::string &wireKey) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  if (!SHA256(reinterpret_cast<const unsigned char *>(wireKey.data()), wireKey.size(), digest))
    throw Error("INTERNAL", "Host key fingerprint failed");
  auto encoded = base64(std::string(reinterpret_cast<char *>(digest), sizeof digest));
  while (!encoded.empty() && encoded.back() == '=') encoded.pop_back();
  return "SHA256:" + encoded;
}
bool sameHostKey(const std::string &pinned, const char *current, size_t length) {
  return current && pinned.size() == length &&
         CRYPTO_memcmp(pinned.data(), current, length) == 0;
}
KeyPair generateKeyPair(const std::string &comment) {
  if (comment.size() > 4096 || comment.find_first_of("\r\n") != std::string::npos ||
      comment.find('\0') != std::string::npos)
    throw Error("INVALID_ARGUMENT", "Invalid key comment");
  using Context = std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)>;
  using Key = std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)>;
  Context ctx(EVP_PKEY_CTX_new_id(EVP_PKEY_ED25519, nullptr), EVP_PKEY_CTX_free);
  EVP_PKEY *raw = nullptr;
  if (!ctx || EVP_PKEY_keygen_init(ctx.get()) != 1 || EVP_PKEY_keygen(ctx.get(), &raw) != 1)
    throw Error("KEYGEN_FAILED", "Ed25519 key generation failed");
  Key key(raw, EVP_PKEY_free);
  Secret seed{std::string(32, '\0')};
  std::string publicBytes(32, '\0');
  size_t n = 32, m = 32;
  if (EVP_PKEY_get_raw_private_key(key.get(), reinterpret_cast<unsigned char *>(seed.value.data()), &n) != 1 ||
      EVP_PKEY_get_raw_public_key(key.get(), reinterpret_cast<unsigned char *>(publicBytes.data()), &m) != 1 || n != 32 || m != 32)
    throw Error("KEYGEN_FAILED", "Ed25519 key export failed");
  std::string publicBlob;
  field(publicBlob, "ssh-ed25519");
  field(publicBlob, publicBytes);
  Secret secret;
  uint32_t check;
  if (RAND_bytes(reinterpret_cast<unsigned char *>(&check), sizeof check) != 1)
    throw Error("KEYGEN_FAILED", "Random generation failed");
  u32(secret.value, check);
  u32(secret.value, check);
  field(secret.value, "ssh-ed25519");
  field(secret.value, publicBytes);
  seed.value += publicBytes; // OpenSSH stores the 32-byte seed followed by the public key.
  field(secret.value, seed.value);
  field(secret.value, comment);
  for (int pad = 1; secret.value.size() % 8; ++pad) secret.value += static_cast<char>(pad);
  Secret envelope{std::string("openssh-key-v1\0", 15)};
  field(envelope.value, "none");
  field(envelope.value, "none");
  field(envelope.value, "");
  u32(envelope.value, 1);
  field(envelope.value, publicBlob);
  field(envelope.value, secret.value);
  Secret encoded{base64(envelope.value)};
  std::string pem = "-----BEGIN OPENSSH PRIVATE KEY-----\n";
  for (size_t i = 0; i < encoded.value.size(); i += 70) pem += encoded.value.substr(i, 70) + "\n";
  pem += "-----END OPENSSH PRIVATE KEY-----\n";
  return {std::move(pem), "ssh-ed25519 " + base64(publicBlob) + (comment.empty() ? "" : " " + comment)};
}
} // namespace pissh
