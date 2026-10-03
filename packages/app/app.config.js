const pkg = require("./package.json");
const { getNativeReleaseVersion } = require("./native-release-version");

const appVariant = process.env.APP_VARIANT ?? "production";

const variants = {
  production: {
    name: "Pi",
    packageId: "com.owa1da.pimobile",
  },
  development: {
    name: "Pi Debug",
    packageId: "com.owa1da.pimobile.debug",
  },
};

const variant = variants[appVariant] ?? variants.production;
const nativeReleaseVersion = getNativeReleaseVersion(pkg.version);

export default ({ config }) => ({
  name: variant.name,
  slug: "pi-mobile",
  owner: "owaida",
  version: nativeReleaseVersion.appVersion,
  // Rotation is allowed: chat and code read wider in landscape.
  orientation: "default",
  icon: "./assets/images/icon.png",
  scheme: "pimobile",
  userInterfaceStyle: "automatic",
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    infoPlist: {
      NSLocalNetworkUsageDescription: "Connect to your SSH hosts on your local network.",
      // Complete Apple's export-compliance review for the shipped SSH library before
      // declaring an encryption exemption. An omitted flag leaves the questionnaire open.
    },
    bundleIdentifier: variant.packageId,
    buildNumber: config.ios?.buildNumber ?? "1",
  },
  android: {
    adaptiveIcon: {
      backgroundColor: "#000000",
      foregroundImage: "./assets/images/android-icon-foreground.png",
    },
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    softwareKeyboardLayoutMode: "resize",
    permissions: [],
    package: variant.packageId,
    versionCode: nativeReleaseVersion.androidVersionCode,
  },
  web: {
    output: "single",
    favicon: "./assets/images/favicon.png",
  },
  autolinking: {
    searchPaths: ["../../node_modules", "./node_modules"],
  },
  plugins: [
    "expo-router",
    ["./plugins/with-android-async-storage-size", 64],
    [
      "expo-splash-screen",
      {
        image: "./assets/images/splash-icon.png",
        imageWidth: 200,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        dark: {
          image: "./assets/images/splash-icon-dark.png",
          backgroundColor: "#000000",
        },
      },
    ],
    [
      "expo-gradle-jvmargs",
      {
        xmx: "4096m",
        maxMetaspace: "1024m",
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          minSdkVersion: 29,
          kotlinVersion: "2.1.20",
        },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
    autolinkingModuleResolution: true,
  },
  extra: {
    router: {},
    eas: {
      projectId: "d2696fae-ad1a-472f-9b34-8aeb34f66b20",
    },
  },
});
