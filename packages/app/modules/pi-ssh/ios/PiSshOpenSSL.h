#pragma once

// The CocoaPod supplies an OpenSSL.framework; portable tests use ordinary
// OpenSSL headers. Select the namespace without shadowing framework headers.
#ifdef PISSH_OPENSSL_FRAMEWORK
#define PISSH_OPENSSL_HEADER(name) <OpenSSL/name>
#else
#define PISSH_OPENSSL_HEADER(name) <openssl/name>
#endif
