# JSch instantiates its algorithm implementations by class name (JSch.getConfig -> Class.forName).
-keep class com.jcraft.jsch.** { *; }
-dontwarn com.jcraft.jsch.**
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**
-dontwarn org.newsclub.net.unix.**
-dontwarn org.ietf.jgss.**
-dontwarn org.apache.logging.log4j.**
-dontwarn org.slf4j.**
-dontwarn com.sun.jna.**
