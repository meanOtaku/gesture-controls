@rem Minimal Gradle wrapper launcher for Windows.
@rem See gradle/wrapper/gradle-wrapper.properties for the pinned distribution.
@echo off
setlocal
set APP_HOME=%~dp0
cd /d "%APP_HOME%"
if defined JAVA_HOME (
  set JAVA_EXE=%JAVA_HOME%\bin\java.exe
) else (
  set JAVA_EXE=java.exe
)
"%JAVA_EXE%" %JAVA_OPTS% %GRADLE_OPTS% -classpath "%APP_HOME%\gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain %*
endlocal
