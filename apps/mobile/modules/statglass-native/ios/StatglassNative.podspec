Pod::Spec.new do |s|
  s.name           = 'StatglassNative'
  s.version        = '0.0.0'
  s.summary        = 'The StatGlass iPhone app pipe to its Rust core'
  s.description    = 'Expo module wrapping the statglass-mobile UniFFI facade, the phone key signer and app lifecycle hooks'
  s.author         = 'StatGlass'
  s.homepage       = 'https://github.com/steamfield/statglass'
  s.license        = { :type => 'Apache-2.0' }
  s.platforms      = { :ios => '16.0' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Built and git-ignored by scripts/mobile/build-rust-ios.sh: the Rust static library
  # and the Swift bindings UniFFI generates for it (ios/generated/).
  s.vendored_frameworks = 'StatglassCore.xcframework'
  s.source_files = '**/*.swift'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
end
