#import "PiSshBridge.h"
#import <dispatch/dispatch.h>
#include "PiSshCore.hpp"
#include <openssl/crypto.h>
#include <climits>
#include <cmath>

namespace {
std::string bytes(NSString *value) {
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
  return data.length ? std::string(static_cast<const char *>(data.bytes), data.length) : std::string();
}
NSString *text(const std::string &value) {
  // NSString's strict initializer returns nil on malformed UTF-8; do not turn
  // malformed command output into a nil dictionary value or an empty string.
  NSString *decoded = [[NSString alloc] initWithBytes:value.data() length:value.size() encoding:NSUTF8StringEncoding];
  if (decoded) return decoded;
  // Preserve valid sequences and substitute U+FFFD for invalid bytes.
  NSMutableString *result = [NSMutableString string];
  for (size_t i = 0; i < value.size();) {
    unsigned char c = value[i];
    size_t n = c < 0x80 ? 1 : c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
    NSString *piece = n && i + n <= value.size()
      ? [[NSString alloc] initWithBytes:value.data() + i length:n encoding:NSUTF8StringEncoding] : nil;
    [result appendString:piece ?: @"\uFFFD"];
    i += piece ? n : 1;
  }
  return result;
}
std::optional<std::string> optionalString(NSDictionary *options, NSString *name) {
  id value = options[name];
  if (!value || value == [NSNull null]) return std::nullopt;
  if (![value isKindOfClass:NSString.class]) throw pissh::Error("INVALID_ARGUMENT", "Expected string option");
  return bytes(value);
}
int integer(id value, int fallback) {
  if (!value || value == [NSNull null]) return fallback;
  if (![value isKindOfClass:NSNumber.class]) throw pissh::Error("INVALID_ARGUMENT", "Expected numeric option");
  double n = [value doubleValue];
  if (!std::isfinite(n) || n < INT_MIN || n > INT_MAX) throw pissh::Error("INVALID_ARGUMENT", "Invalid numeric option");
  return static_cast<int>(n);
}
void finish(PiSshCompletion completion, id result, const std::optional<pissh::Error> &error) {
  NSString *code = error ? text(error->code) : nil;
  NSString *message = error ? text(error->what()) : nil;
  dispatch_async(dispatch_get_main_queue(), ^{ completion(result, code, message); });
}
}

@implementation PiSshBridge {
  std::unique_ptr<pissh::Core> _core;
}
- (instancetype)init {
  if ((self = [super init])) {
    __weak PiSshBridge *weakSelf = self;
    _core = std::make_unique<pissh::Core>([weakSelf](const pissh::Event &event) {
      @autoreleasepool {
        NSString *name = text(event.name);
        NSDictionary *body = event.name == "onHostKey"
          ? @{@"connectionId": text(event.connectionId), @"requestId": text(event.requestId),
              @"algorithm": text(event.algorithm), @"fingerprint": text(event.fingerprint)}
          : @{@"connectionId": text(event.connectionId), @"reason": text(event.reason)};
        dispatch_async(dispatch_get_main_queue(), ^{
          PiSshEmitter emit = weakSelf.emitter;
          if (emit) emit(name, body);
        });
      }
    });
  }
  return self;
}
- (void)connect:(NSDictionary<NSString *, id> *)options completion:(PiSshCompletion)completion {
  try {
    pissh::Options o;
    o.id = optionalString(options, @"connectionId").value_or("");
    o.host = optionalString(options, @"host").value_or("");
    o.username = optionalString(options, @"username").value_or("");
    o.port = integer(options[@"port"], 22);
    o.timeoutMs = integer(options[@"timeoutMs"], 20000);
    o.hostKeyTimeoutMs = integer(options[@"hostKeyTimeoutMs"], 120000);
    o.keepaliveMs = integer(options[@"keepaliveIntervalMs"], 15000);
    o.password = optionalString(options, @"password");
    o.privateKey = optionalString(options, @"privateKey");
    o.passphrase = optionalString(options, @"passphrase");
    if (o.privateKey && o.privateKey->empty()) o.privateKey.reset();
    NSString *identifier = text(o.id);
    _core->connect(std::move(o), [completion, identifier](std::optional<pissh::Error> error) {
      @autoreleasepool { finish(completion, error ? nil : identifier, error); }
    });
  } catch (const pissh::Error &error) { finish(completion, nil, error); }
    catch (...) { finish(completion, nil, pissh::Error("INTERNAL", "SSH operation failed")); }
}
- (BOOL)respondHostKey:(NSString *)requestId accept:(BOOL)accept {
  return _core->respondHostKey(bytes(requestId), accept);
}
- (void)exec:(NSString *)connectionId command:(NSString *)command input:(NSString *)input
  timeoutMs:(NSNumber *)timeoutMs completion:(PiSshCompletion)completion {
  try {
    _core->exec(bytes(connectionId), bytes(command), bytes(input), integer(timeoutMs, 0),
      [completion](pissh::Result result, std::optional<pissh::Error> error) {
        @autoreleasepool {
          finish(completion, error ? nil : @{@"stdout": text(result.out), @"stderr": text(result.err),
            @"exitCode": result.status ? @(*result.status) : [NSNull null]}, error);
        }
      });
  } catch (const pissh::Error &error) { finish(completion, nil, error); }
    catch (...) { finish(completion, nil, pissh::Error("INTERNAL", "SSH operation failed")); }
}
- (BOOL)isConnected:(NSString *)connectionId { return _core->isConnected(bytes(connectionId)); }
- (void)disconnect:(NSString *)connectionId { _core->disconnect(bytes(connectionId)); }
- (void)generateKeyPair:(NSString *)comment completion:(PiSshCompletion)completion {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @autoreleasepool {
      try {
        auto key = pissh::generateKeyPair(bytes(comment));
        NSDictionary *result = @{@"privateKey": text(key.privateKey), @"publicKey": text(key.publicKey)};
        OPENSSL_cleanse(key.privateKey.data(), key.privateKey.size());
        finish(completion, result, std::nullopt);
      } catch (const pissh::Error &error) { finish(completion, nil, error); }
        catch (...) { finish(completion, nil, pissh::Error("KEYGEN_FAILED", "Key generation failed")); }
    }
  });
}
- (void)destroy { _core->destroy(); self.emitter = nil; }
- (void)dealloc { _core->destroy(); }
@end
