"use client";

import type { AccountInfo, ShareSummary } from "@/lib/data";
import { ProfileSection } from "./profile-section";
import { PreferencesSection } from "./preferences-section";
import { MyServicesSection, type ProviderOption } from "./my-services-section";
import { RememberFiltersSection } from "./remember-filters-section";
import { ApiKeySection } from "./api-key-section";
import { SharedLinksSection } from "./shared-links-section";
import { TagsSection, type TagSummary } from "./tags-section";
import { TwoFactorSection } from "./two-factor-section";
import { PasswordSection } from "./password-section";
import { DevicesSection } from "./devices-section";
import {
  MetadataSyncSection,
  type MetadataFailureSummary,
} from "./metadata-sync-section";
import { BackupSection } from "./backup-section";
import { DangerSection } from "./danger-section";
import { AboutSection } from "./about-section";

export type { MetadataFailureSummary, ProviderOption, TagSummary };

export function SettingsClient({
  info,
  shares,
  tags,
  timeZone,
  watchRegion,
  watchRegions,
  myProviders,
  providers,
  providersUnavailable,
  metadataFailures,
  lastBackupAt,
  backupAgeDays,
  rememberFilters,
}: {
  info: AccountInfo;
  shares: ShareSummary[];
  tags: TagSummary[];
  timeZone: string;
  watchRegion: string;
  /** TMDB's streaming regions, sorted by name. */
  watchRegions: string[];
  myProviders: number[];
  providers: ProviderOption[];
  providersUnavailable: boolean;
  metadataFailures: MetadataFailureSummary[];
  /** ISO timestamp of the last successful backup download, or null. */
  lastBackupAt: string | null;
  /** Whole days since that backup, measured server-side. Null when there is none. */
  backupAgeDays: number | null;
  rememberFilters: boolean;
}) {
  return (
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-2">
      <ProfileSection name={info.name} email={info.email} />
      <PreferencesSection
        timeZone={timeZone}
        watchRegion={watchRegion}
        watchRegions={watchRegions}
      />
      <div className="lg:col-span-2">
        <MyServicesSection
          key={watchRegion}
          region={watchRegion}
          initialProviderIds={myProviders}
          providers={providers}
          unavailable={providersUnavailable}
        />
      </div>
      <RememberFiltersSection initialEnabled={rememberFilters} />
      <ApiKeySection hasApiKey={info.hasApiKey} hasServerKey={info.hasServerKey} />
      <SharedLinksSection shares={shares} />
      <TagsSection tags={tags} />
      <TwoFactorSection enabled={info.twoFactorEnabled} />
      <PasswordSection />
      <div className="lg:col-span-2">
        {/* Turning 2FA on or off replaces this device's session, and turning
            it on signs out the others, so reload the list when it flips. */}
        <DevicesSection key={info.twoFactorEnabled ? "2fa-on" : "2fa-off"} />
      </div>
      <div className="lg:col-span-2">
        <MetadataSyncSection failures={metadataFailures} />
      </div>
      <BackupSection lastBackupAt={lastBackupAt} backupAgeDays={backupAgeDays} />
      <DangerSection />
      <div className="lg:col-span-2">
        <AboutSection />
      </div>
    </div>
  );
}
