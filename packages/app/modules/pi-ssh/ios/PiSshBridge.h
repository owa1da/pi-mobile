#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
typedef void (^PiSshCompletion)(id _Nullable result, NSString * _Nullable code, NSString * _Nullable message);
typedef void (^PiSshEmitter)(NSString *name, NSDictionary<NSString *, id> *body);

@interface PiSshBridge : NSObject
@property (atomic, copy, nullable) PiSshEmitter emitter;
- (void)connect:(NSDictionary<NSString *, id> *)options completion:(PiSshCompletion)completion
  NS_SWIFT_NAME(connect(_:completion:));
- (BOOL)respondHostKey:(NSString *)requestId accept:(BOOL)accept
  NS_SWIFT_NAME(respondHostKey(_:accept:));
// Avoid the C stdio `stdin` macro in Objective-C selectors and Swift names.
- (void)exec:(NSString *)connectionId command:(NSString *)command input:(nullable NSString *)input
  timeoutMs:(nullable NSNumber *)timeoutMs completion:(PiSshCompletion)completion
  NS_SWIFT_NAME(exec(_:command:input:timeoutMs:completion:));
- (BOOL)isConnected:(NSString *)connectionId NS_SWIFT_NAME(isConnected(_:));
- (void)disconnect:(NSString *)connectionId NS_SWIFT_NAME(disconnect(_:));
- (void)generateKeyPair:(NSString *)comment completion:(PiSshCompletion)completion
  NS_SWIFT_NAME(generateKeyPair(_:completion:));
- (void)destroy NS_SWIFT_NAME(destroy());
@end
NS_ASSUME_NONNULL_END
