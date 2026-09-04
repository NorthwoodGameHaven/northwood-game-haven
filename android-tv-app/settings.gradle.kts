// NGH TV kiosk shell — NGH-BUILD 2026-09-04a (recovered + re-versioned from 2026-08-24c)
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "NGH TV"
include(":app")
