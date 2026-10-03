Pod::Spec.new do |s|
  s.name = 'PiSsh'
  s.version = '0.1.0'
  s.summary = 'Direct SSH transport for Pi, with explicit pre-authentication host trust.'
  s.description = 'Expo SSH connections with asynchronous host trust, password/key authentication, concurrent exec, and Ed25519 key generation.'
  s.license = { :type => 'Apache-2.0', :file => '../../../../../LICENSE' }
  s.author = 'Pi contributors'
  s.homepage = 'https://github.com/owa1da/pi-mobile'
  s.source = { :git => 'https://github.com/owa1da/pi-mobile.git' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.requires_arc = true
  # Compile private C/C++/ObjC++ sources textually: OpenSSL's C headers are not
  # C++ Clang modules. Swift still imports the public Foundation-only bridge.
  s.compiler_flags = '-fno-modules'
  s.dependency 'ExpoModulesCore'
  # Maintained XCFramework; exact version, including OpenSSL 3.6.2 / Ed25519.
  s.dependency 'OpenSSL-Universal', '3.6.2000'
  s.libraries = 'c++'

  # The upstream Makefile.inc list. crypto.c includes openssl.c, and bcrypt_pbkdf.c
  # includes blowfish.c: do NOT compile those translation units twice.
  sources = %w[agent bcrypt_pbkdf channel comp chacha cipher-chachapoly crypt crypto
               global hostkey keepalive kex knownhost mac misc packet pem poly1305
               publickey scp session sftp transport userauth userauth_kbd_packet version]
  s.source_files = ['*.{h,hpp,cpp,mm,swift}', 'vendor/libssh2/{include,src}/*.h'] +
                   sources.map { |name| "vendor/libssh2/src/#{name}.c" }
  s.header_mappings_dir = '.'
  s.public_header_files = 'PiSshBridge.h'
  s.private_header_files = ['PiSshCore.hpp', 'PiSshOpenSSL.h', 'libssh2_config.h', 'vendor/libssh2/{include,src}/*.h']
  s.preserve_paths = ['vendor/libssh2/src/*.c']
  s.resource_bundles = {
    'PiSshLicenses' => ['vendor/libssh2/COPYING', 'vendor/OpenSSL-LICENSE.txt', 'vendor/NOTICE.txt']
  }
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) HAVE_CONFIG_H=1 LIBSSH2_OPENSSL=1 PISSH_OPENSSL_FRAMEWORK=1',
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)" "$(PODS_TARGET_SRCROOT)/vendor/libssh2/include" "$(PODS_TARGET_SRCROOT)/vendor/libssh2/src"',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
