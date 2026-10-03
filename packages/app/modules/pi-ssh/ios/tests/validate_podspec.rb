# Run with Ruby and cocoapods-core 1.16.2. No Xcode, pod install, or app changes.
require 'cocoapods-core'

root = File.expand_path('..', __dir__)
spec = Pod::Specification.from_file(File.join(root, 'PiSsh.podspec'))
linter = Pod::Specification::Linter.new(spec)
linter.lint
linter.results.each { |result| puts "#{result.type}: #{result.attribute_name}: #{result.message}" }
abort 'Podspec has errors' unless linter.errors.empty?
raise 'Wrong module' unless spec.name == 'PiSsh' && spec.module_name == 'PiSsh'
raise 'Must be static' unless spec.static_framework
raise 'Wrong deployment target' unless spec.deployment_target(:ios) == '15.1'
raise 'Missing Expo dependency' unless spec.dependencies.any? { |d| d.name == 'ExpoModulesCore' }
crypto = spec.dependencies.find { |d| d.name == 'OpenSSL-Universal' }
raise 'Unpinned OpenSSL dependency' unless crypto && crypto.requirement.to_s == '= 3.6.2000'

consumer = spec.consumer(:ios)
Dir.chdir(root) do
  raise 'Missing license' unless File.file?(spec.license[:file])
  sources = consumer.source_files.flat_map do |pattern|
    matches = Dir.glob(pattern)
    raise "Unmatched source pattern #{pattern}" if matches.empty?
    matches
  end
  raise 'Tests must not compile in the pod' if sources.any? { |p| p.start_with?('tests/') }
  raise 'Duplicate backend translation unit' if sources.include?('vendor/libssh2/src/openssl.c')
  raise 'Duplicate bcrypt translation unit' if sources.include?('vendor/libssh2/src/blowfish.c')
  raise 'Wrong public header' unless consumer.public_header_files == ['PiSshBridge.h']
  raise 'Missing OpenSSL namespace selector' unless sources.include?('PiSshOpenSSL.h')
  raise 'Conflicting OpenSSL shims' if sources.any? { |p| p.start_with?('apple-headers/') }
  raise 'Private sources must use textual C headers' unless Array(consumer.compiler_flags).join(' ').include?('-fno-modules')
  raise 'Missing framework selection' unless consumer.pod_target_xcconfig['GCC_PREPROCESSOR_DEFINITIONS'].include?('PISSH_OPENSSL_FRAMEWORK=1')
  consumer.resource_bundles.each_value do |patterns|
    patterns.each { |pattern| raise "Missing resource #{pattern}" if Dir.glob(pattern).empty? }
  end
  puts "PASS PiSsh podspec: #{sources.size} source/header files, pinned dependency, license resources, private C++ headers"
end
