cmake_minimum_required(VERSION 3.16)
project(pi_ssh_portable LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)
set(ROOT "${CMAKE_CURRENT_LIST_DIR}/..")
set(SSH_SOURCES agent bcrypt_pbkdf channel comp chacha cipher-chachapoly crypt crypto
  global hostkey keepalive kex knownhost mac misc packet pem poly1305 publickey scp
  session sftp transport userauth userauth_kbd_packet version)
list(TRANSFORM SSH_SOURCES PREPEND "${ROOT}/vendor/libssh2/src/")
list(TRANSFORM SSH_SOURCES APPEND ".c")
add_library(pissh_ssh2 STATIC ${SSH_SOURCES})
target_include_directories(pissh_ssh2 PUBLIC "${ROOT}/vendor/libssh2/include" PRIVATE "${ROOT}" "${ROOT}/vendor/libssh2/src")
target_compile_definitions(pissh_ssh2 PRIVATE HAVE_CONFIG_H=1 LIBSSH2_OPENSSL=1)
target_link_libraries(pissh_ssh2 PUBLIC OpenSSL::Crypto)
add_library(pissh_core STATIC "${ROOT}/PiSshCore.cpp" "${ROOT}/PiSshCrypto.cpp")
target_include_directories(pissh_core PUBLIC "${ROOT}")
target_compile_options(pissh_core PRIVATE -Wall -Wextra -Werror)
# Numeric diagnostics only in the portable test target, never the iOS pod.
target_compile_definitions(pissh_core PRIVATE PISSH_TEST_DIAGNOSTICS=1)
target_link_libraries(pissh_core PUBLIC pissh_ssh2 Threads::Threads)
add_executable(pissh_harness harness.cpp)
target_link_libraries(pissh_harness PRIVATE pissh_core)

# Deterministic socket backpressure against the same production core. Linux's
# link wrappers are test-only; no injection hooks enter the pod or shared API.
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_executable(pissh_packet_wait_test packet_wait_test.c)
  target_include_directories(pissh_packet_wait_test PRIVATE "${ROOT}" "${ROOT}/vendor/libssh2/src")
  target_compile_definitions(pissh_packet_wait_test PRIVATE HAVE_CONFIG_H=1 LIBSSH2_OPENSSL=1)
  target_compile_options(pissh_packet_wait_test PRIVATE -Wall -Wextra -Werror)
  target_link_libraries(pissh_packet_wait_test PRIVATE pissh_ssh2)
  target_link_options(pissh_packet_wait_test PRIVATE "-Wl,--wrap=_libssh2_transport_read")
  add_executable(pissh_fault_harness fault_harness.cpp send_faults.cpp)
  target_link_libraries(pissh_fault_harness PRIVATE pissh_core)
  target_compile_options(pissh_fault_harness PRIVATE -Wall -Wextra -Werror)
  foreach(symbol send libssh2_session_handshake libssh2_userauth_publickey_frommemory
      libssh2_channel_open_ex libssh2_channel_process_startup
      libssh2_channel_read_ex libssh2_channel_write_ex libssh2_channel_send_eof
      libssh2_channel_close libssh2_channel_wait_eof libssh2_channel_wait_closed
      libssh2_channel_free)
    target_link_options(pissh_fault_harness PRIVATE "-Wl,--wrap=${symbol}")
  endforeach()
endif()
