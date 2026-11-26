/**
 * macOS system daemons and agents by the user each runs as, taken from a
 * working Mac's process list (Apple executables only: nothing installed or
 * named by its owner). `IDLE_PROCESSES` in `fixtures.ts` fills the mock's
 * process table out from these, so it reads like a real Mac's.
 */
export const IDLE_DAEMONS: readonly (readonly [
  user: string,
  names: readonly string[],
])[] = [
  [
    "me",
    (
      "SetStoreUpdateService|MTLCompilerService|mdworker_shared|" +
      "com.apple.audio.SandboxHelper|com.apple.WebKit.WebContent|" +
      "com.apple.WebKit.Networking|com.apple.WebKit.GPU|" +
      "ThemeWidgetControlViewService|QuickLookUIService|triald|siriknowledged|" +
      "pkd|intents_helper|com.apple.dock.external.extra.arm64|webprivacyd|" +
      "webinspectord|usernotificationsd|usernoted|useractivityd|" +
      "universalaccessd|universalAccessAuthWarn|trustd|transparencyd|" +
      "translationd|tipsd|textunderstandingd|textcomposerd|talagentd|" +
      "syncdefaultsd|swtransparencyd|swcd|suggestd|studentd|storeuid|" +
      "storekitd|storekitagent|stickersd|ssh-agent|" +
      "spotlightknowledged.updater|spotlightknowledged.importer|" +
      "spindump_agent|speechmaintenanced|sociallayerd|siriinferenced|" +
      "siriappintentsd|siriactionsd|sharingd|seserviced|secinitd|secd|" +
      "searchpartyuseragent|routined|replicatord|replayd|remindd|recentsd|" +
      "rapportd|promotedcontentd|proactiveeventtrackerd|proactived|" +
      "privatecloudcomputed|postersyncd|photolibraryd|photoanalysisd|peopled|" +
      "pbs|pboard|passd|parsecd|nsurlsessiond|nsattributedstringagent|" +
      "networkserviceproxy|neagent|mobiletimerd|mlhostd|metrickitd|" +
      "mediaremoteagent|mediaanalysisd|mdwrite|mdbulkimport|mapssyncd|" +
      "managedcorespotlightd|maild|loginwindow|lockoutagent|" +
      "localizationswitcherd|liveactivitiesd|linkd|knowledgeconstructiond|" +
      "knowledge-agent|keyboardservicesd|itunescloudd|intelligentroutingd|" +
      "intelligencetasksd|intelligenceplatformd|intelligenceflowd|" +
      "intelligencecontextd|installerauthagent|inputanalyticsd|imklaunchagent|" +
      "imageplaygroundd|imagent|identityservicesd|iconservicesagent|iPhone|" +
      "iCloudNotificationAgent|hybridsearchd|homeenergyd|homed|heard|" +
      "geodMachServiceBridge|geoanalyticsd|generativeexperiencesd|" +
      "gamecontrolleragentd|fskit_agent|frauddefensed|fontworker|fontd|" +
      "followupd|findmylocateagent|findmydevice-user-agent|fileproviderd|" +
      "feedbackd|familycircled|duetexpertd|dtuhidd|dtpasteboardd|" +
      "dtdeviceinfod|donotdisturbd|dmd|diagnostics_agent|devicecheckd|deleted|" +
      "dataaccessd|ctkd|ctkahp|corespotlightd|corespeechd|coreautha|" +
      "contentlinkingd|containermanagerd|contactsd|commerce|com.apple.sbd|" +
      "com.apple.quicklook.ThumbnailsAgent|" +
      "com.apple.photos.ImageConversionService|" +
      "com.apple.hiservices-xpcservice|com.apple.fskit.msdos|" +
      "com.apple.dock.extra|com.apple.appkit.xpc.openAndSavePanelService|" +
      "com.apple.accessibility.mediaaccessibilityd|" +
      "com.apple.Notes.SpotlightIndexExtension|" +
      "com.apple.CloudDocs.iCloudDriveFileProvider|ciphermld|chronod|cdpd|" +
      "callservicesd|calaccessd|bird|axassetsd|avconferenced|audioaccessoryd|" +
      "assistantd|assistant_cdmd|assetsubscriptiond|assessmentagent|" +
      "appstoreagent|appleaccountd|announced|analyticsagent|" +
      "amsondevicestoraged|amsengagementd|amsaccountsd|akd|agentstored|" +
      "adprivacyd|accountsd|WindowManager|WidgetRenderer_Activities|" +
      "WiFiMacSettingsIntents|WiFiAgent|WeatherWidget|" +
      "WallpaperSettingsIntents|WallpaperAgent|WallpaperAerialsExtension|" +
      "VpnSettingsIntents|ViewBridgeAuxiliary|VPN|UserNotificationCenter|" +
      "UsageTrackingAgent|UnknownSendersBlastDoorService|UniversalControl|" +
      "UIKitSystem|TrustedPeersHelper|TrackpadIntentsExtension|" +
      "TimeMachineSettingsIntents|TextInputMenuAgent|SystemUIServer|" +
      "StorageSettingsIntentsExtension|StatusKitAgent|" +
      "StartupDiskWidgetExtension|SpotlightSettingsIntentsExtension|" +
      "SoundIntentsExtension|SoftwareUpdateSettingsExtensionIntents|" +
      "SoftwareUpdateNotificationManager|SiriSuggestionsBookkeepingService|" +
      "SiriSetupSettingsIntents|SiriPreferenceExtension|Siri|SidecarRelay|" +
      "ShortcutsViewService|ShareSheetUI|Setup|ScopedBookmarkAgent|" +
      "SSMenuAgent|QLPreviewGenerationExtension|ProtectedCloudKeySyncing|" +
      "ProfilesSettingsIntents|PrefPaneSearchIntent|PowerChime|" +
      "PlaceholderSettingsSearchTermsIntents|PhotosPosterProvider|" +
      "PasswordSettingsAppIntentsExtension|PasswordBreachAgent|" +
      "NotificationsSettingsIntents|NotificationCenter|Notes|Network|" +
      "MouseIntentsExtension|ModelCatalogAgent|MobileDeviceUpdater|" +
      "MenuBarAgent|ManagedSettingsAgent|MTLAssetUpgraderD|" +
      "MENotificationAgent|Keychain|KeyboardSettingsIntents|" +
      "InternationalSettingsExtension|IntelligencePlatformComputeService|" +
      "ImageThumbnailExtension|Image|IMTransferAgent|IMDPersistenceAgent|" +
      "IDSBlastDoorService|HeadphoneSettingsExtension|GeneralSettings|" +
      "GamePolicyAgent|GameControllerSettingsIntents|" +
      "GameCenterSettingsSearchExtension|FollowUpSettingsExtension|" +
      "FolderActionsDispatcher|Finder|FeatureAccessAgent|FamilySettings|" +
      "FamilyIntents|DockHelper|Dock|DoNotDisturbAppIntents|" +
      "DiskUnmountWatcher|DeviceConfigurationAgent|DesktopSettingsIntents|" +
      "DateTimeIntentsExtension|CursorUIViewService|" +
      "CredentialProviderExtensionHelper|CoreServicesUIAgent|" +
      "CoreLocationAgent|ControlCenterSettingsIntents|ControlCenterSettings|" +
      "ControlCenterHelper|ControlCenter|ContinuityCaptureAgent|" +
      "ContextStoreAgent|ContainerMetadataExtractor|CommCenter|" +
      "ClassroomSettings|ClassroomDeviceExpert|ClassKitAppIntents|" +
      "CallHistorySyncHelper|CallHistoryPluginHelper|CalendarIntentsExtension|" +
      "CMFSyncAgent|CDsAndDvDsSettingsIntents|" +
      "BluetoothSettingsAppIntentsWidgetExtension|" +
      "BiometricsAndPasswordSettingsAppIntentsExtension|BiomeAgent|" +
      "BatterySettingsIntentsExtension|BackgroundTaskManagementAgent|" +
      "BTLEServerAgent|AuthenticationServicesAgent|AudioComponentRegistrar|" +
      "AssetCacheLocatorService|AppleSpell|AppleIDSettings|" +
      "AppleAccountIntents_macOS|AppSSOAgent|" +
      "AppPredictionIntentsHelperService|AirPlayUIAgent|" +
      "AirDropHandoffIntentsExtension|AirDrop|AccountsUISettingsAppIntents|" +
      "AccessibilityVisualsAgent|AccessibilityUIServer|" +
      "AccessibilitySettingsSearchExtension|ARDAgent|AMPDeviceDiscoveryAgent"
    ).split("|"),
  ],
  [
    "root",
    (
      "systemstats|xprotectd|wifivelocityd|wifip2pd|watchdogd|usermanagerd|" +
      "usbpowerd|uncd|triald_system|thermalmonitord|tccd|taskgated|" +
      "systemstatusd|systemsoundserverd|system_installd|syspolicyd|sysmond|" +
      "syslogd|sysextd|storagekitd|spindump|socketfilterfw|smd|" +
      "sharedfilelistd|seputil|securityd_system|securityd|searchpartyd|" +
      "sandboxd|runningboardd|rtcreportingd|revisiond|remoted|" +
      "powerexperienced|powerd|peakpowermanagerd|ospredictiond|" +
      "osanalyticshelper|opendirectoryd|online-auth-agent|notifyd|" +
      "nesessionmanager|nehelper|modelcatalogd|mobileassetd|mobileactivationd|" +
      "mediaremoted|mds|mDNSResponderHelper|lsd|logind|logd_helper|logd|" +
      "liquiddetectiond|launchservicesd|keybagd|kernelmanagerd|kdc|ioupsd|" +
      "installd|hdiejectd|gamepolicyd|fskitd|fseventsd|findmydeviced|" +
      "findmybeaconingd|filecoordinationd|eligibilityd|ecosystemd|distnoted|" +
      "diskarbitrationd|dirhelper|diagnosticd|deviceconfigurationd|" +
      "deleted_helper|dbtelemetryd|dasd|cryptexd|countryd|coresymbolicationd|" +
      "coreservicesd|corercd|corekdld|coreduetd|corebrightnessd|coreauthd|" +
      "contextstored|containermanagerd_system|configd|com.apple.geod|" +
      "com.apple.fpsd.arcadeservice|com.apple.cmio.registerassistantservice|" +
      "com.apple.MobileSoftwareUpdate.CleanupPreparePathService|" +
      "com.apple.AmbientDisplayAgent|cloudtelemetryd|cloudd|clocksyncd|" +
      "cfprefsd|bluetoothd|biometrickitd|backupd-helper|backupd|" +
      "backgroundtaskmanagementd|automationmode-writer|authd|audioanalyticsd|" +
      "apsd|applekeystored|apfsd|aned|amfid|airportd|XprotectService|" +
      "XProtectBridgeService|WirelessRadioManagerd|UserEventAgent|" +
      "TrialArchivingService|SubmitDiagInfo|Software|ReportCrash|PowerUIAgent|" +
      "PerfPowerTelemetryClientRegistrationService|PerfPowerServices|" +
      "KernelEventAgent|InternetSharing|IOMFB_bics_daemon|GSSCred|" +
      "CrashReporterSupportHelper|ContextService|CategoriesService|CVMServer|" +
      "AssetCacheTetheratorService|AppleCredentialManagerDaemon|AppSSODaemon|" +
      "AirPlayXPCHelper"
    ).split("|"),
  ],
  ["_accessoryupdater", "accessoryupdaterd|UARPUpdaterServiceUSBPD".split("|")],
  ["_analyticsd", "analyticsd".split("|")],
  ["_appleevents", "appleeventsd".split("|")],
  ["_applepay", "nfcd|NFStorageServer".split("|")],
  ["_assetcache", "AssetCache".split("|")],
  ["_audiomxd", "audiomxd".split("|")],
  ["_biome", "biomed".split("|")],
  [
    "_cmiodalassistants",
    (
      "com.apple.cmio.videodriverkithostextension|cameracaptured|" +
      "appleh13camerad|VDCAssistant|UVCAssistant"
    ).split("|"),
  ],
  ["_coreaudiod", "coreaudiod".split("|")],
  ["_corespeechd", "corespeechd_system".split("|")],
  ["_diagnosticservicesd", "diagnosticservicesd".split("|")],
  ["_diskimagesiod", "diskimagesiod".split("|")],
  [
    "_driverkit",
    (
      "IOUserBluetoothSerialDriver|" +
      "com.apple.DriverKit-IOUserDockChannelSerial|" +
      "com.apple.DriverKit-AppleBCMWLAN|com.apple.AppleUserHIDDrivers"
    ).split("|"),
  ],
  [
    "_fpsd",
    "fpassetmanagerd|fairplaydeviceidentityd|fairplayd|adid".split("|"),
  ],
  ["_gamecontrollerd", "gamecontrollerd".split("|")],
  ["_hidd", "hidd".split("|")],
  ["_iconservices", "iconservicesd".split("|")],
  ["_locationd", "locationd".split("|")],
  ["_mdnsresponder", "mDNSResponder".split("|")],
  ["_mds_stores", "mds_stores".split("|")],
  [
    "_modelmanagerd",
    (
      "TGOnDeviceInferenceProviderService|modelmanagerd|" +
      "PCCAgentClientExtension|GenerativeExperiencesSafetyInferenceProvider"
    ).split("|"),
  ],
  ["_nearbyd", "nearbyd".split("|")],
  ["_netbios", "netbiosd".split("|")],
  ["_networkd", "symptomsd".split("|")],
  ["_neuralengine", "aneuserd".split("|")],
  ["_softwareupdate", "softwareupdated".split("|")],
  ["_timed", "timed".split("|")],
  ["_trustd", "ValidUpdater".split("|")],
  ["_usbmuxd", "usbmuxd".split("|")],
  ["_windowserver", "WindowServer".split("|")],
  ["nobody", "dhcp6d".split("|")],
];
