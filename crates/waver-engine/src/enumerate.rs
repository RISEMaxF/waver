//! Device & host enumeration (spec FR-1.1), mapping cpal 0.18 onto the
//! backend-agnostic [`DeviceInfo`] / [`HostInfo`] types from `waver-core`.

use std::collections::BTreeSet;

use cpal::traits::{DeviceTrait, HostTrait};
use waver_core::engine::{DeviceDirection, DeviceInfo, HostInfo};

/// Standard sample rates we surface in the UI when they fall within a device's
/// supported range. cpal reports ranges (`min..=max`); most backends accept any
/// rate in between, so we offer the common musical/broadcast rates plus the range
/// endpoints.
const STANDARD_RATES: &[u32] = &[
    8_000, 11_025, 16_000, 22_050, 32_000, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000,
];

/// Human-readable name for a device, falling back to its `Display` form.
fn device_name(dev: &cpal::Device) -> String {
    dev.description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| dev.to_string())
}

/// Stable identifier used to re-select the device across restarts (spec FR-1.2).
/// cpal's `DeviceId` is `Display`/`FromStr` and stable across runs where possible.
fn device_id(dev: &cpal::Device) -> String {
    dev.id()
        .map(|id| id.to_string())
        .unwrap_or_else(|_| device_name(dev))
}

/// Collect the supported channel counts and a user-facing sample-rate list for a
/// device in a given direction.
fn supported_channels_and_rates(
    dev: &cpal::Device,
    direction: DeviceDirection,
) -> (Vec<u16>, Vec<u32>) {
    // Materialize (channels, min_rate, max_rate) triples; the two config iterators
    // have different associated types, so handle each branch separately.
    let ranges: Vec<(u16, u32, u32)> = match direction {
        DeviceDirection::Input => dev
            .supported_input_configs()
            .map(|it| {
                it.map(|c| (c.channels(), c.min_sample_rate(), c.max_sample_rate()))
                    .collect()
            })
            .unwrap_or_default(),
        DeviceDirection::Output => dev
            .supported_output_configs()
            .map(|it| {
                it.map(|c| (c.channels(), c.min_sample_rate(), c.max_sample_rate()))
                    .collect()
            })
            .unwrap_or_default(),
    };

    let mut channels = BTreeSet::new();
    for (ch, _, _) in &ranges {
        channels.insert(*ch);
    }
    // Metering opens the device at its maximum channel count (spec FR-2.4), so the
    // offered sample-rate list must reflect what that channel count actually
    // supports — otherwise the UI could list a rate that only exists at a lower
    // channel count and then fails at stream open. Derive rates only from ranges
    // matching the max channel count.
    let max_channels = channels.iter().copied().max();
    let mut rates = BTreeSet::new();
    for (ch, lo, hi) in &ranges {
        if Some(*ch) != max_channels {
            continue;
        }
        // Always offer the range endpoints (cpal guarantees these are openable)...
        rates.insert(*lo);
        rates.insert(*hi);
        // ...plus any standard rate inside the range. This intersection is
        // best-effort: some backends (e.g. ALSA raw-hw) report a continuous range
        // but only accept discrete rates, so an offered rate may still be rejected
        // at open time — that surfaces as a clear error, never a panic.
        for &r in STANDARD_RATES {
            if r >= *lo && r <= *hi {
                rates.insert(r);
            }
        }
    }

    (channels.into_iter().collect(), rates.into_iter().collect())
}

/// Whether `dev` is the host's default device for `direction`.
fn is_default(host: &cpal::Host, dev: &cpal::Device, direction: DeviceDirection) -> bool {
    let default = match direction {
        DeviceDirection::Input => host.default_input_device(),
        DeviceDirection::Output => host.default_output_device(),
    };
    match (default.and_then(|d| d.id().ok()), dev.id().ok()) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn map_device(
    host: &cpal::Host,
    host_name: &str,
    dev: &cpal::Device,
    direction: DeviceDirection,
) -> DeviceInfo {
    let (channels, sample_rates) = supported_channels_and_rates(dev, direction);
    DeviceInfo {
        id: device_id(dev),
        name: device_name(dev),
        host: host_name.to_string(),
        direction,
        is_default: is_default(host, dev, direction),
        channels,
        sample_rates,
    }
}

/// Enumerate every host compiled into this build.
pub fn enumerate_hosts() -> Vec<HostInfo> {
    let default_id = cpal::default_host().id();
    cpal::available_hosts()
        .into_iter()
        .map(|id| HostInfo {
            name: format!("{id:?}"),
            is_default: id == default_id,
        })
        .collect()
}

/// Enumerate all input and output devices across all available hosts (spec FR-1.1).
///
/// A duplex device (both input and output) yields two [`DeviceInfo`] entries — one
/// per direction — so the input and output pickers can list it independently.
pub fn enumerate_devices() -> Vec<DeviceInfo> {
    let mut out = Vec::new();
    for host_id in cpal::available_hosts() {
        let Ok(host) = cpal::host_from_id(host_id) else {
            continue;
        };
        let host_name = format!("{host_id:?}");

        if let Ok(devices) = host.input_devices() {
            for dev in devices {
                out.push(map_device(&host, &host_name, &dev, DeviceDirection::Input));
            }
        }
        if let Ok(devices) = host.output_devices() {
            for dev in devices {
                out.push(map_device(&host, &host_name, &dev, DeviceDirection::Output));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_least_one_host() {
        // The default host is always compiled in, so there is always >= 1 host.
        let hosts = enumerate_hosts();
        assert!(!hosts.is_empty(), "expected at least one host");
        assert_eq!(hosts.iter().filter(|h| h.is_default).count(), 1);
    }

    #[test]
    fn devices_are_wellformed() {
        // Headless CI may have zero devices; when devices DO exist, every entry must
        // be well-formed (non-empty id/name/host, at least one channel count).
        for d in enumerate_devices() {
            assert!(!d.id.is_empty(), "device id must be non-empty");
            assert!(!d.name.is_empty(), "device name must be non-empty");
            assert!(!d.host.is_empty(), "device host must be non-empty");
            assert!(
                matches!(
                    d.direction,
                    DeviceDirection::Input | DeviceDirection::Output
                ),
                "direction must be set"
            );
            if !d.channels.is_empty() {
                assert!(
                    d.channels.iter().all(|&c| c >= 1),
                    "channel counts must be >= 1"
                );
            }
            // Sample rates, when present, must be plausible audio rates.
            assert!(
                d.sample_rates
                    .iter()
                    .all(|&r| (4_000..=768_000).contains(&r)),
                "sample rates out of plausible range: {:?}",
                d.sample_rates
            );
        }
    }

    #[test]
    fn at_most_one_default_per_direction_per_host() {
        // Defaults are unique: for each (host, direction) there is at most one default.
        use std::collections::HashMap;
        let mut counts: HashMap<(String, DeviceDirection), usize> = HashMap::new();
        for d in enumerate_devices().into_iter().filter(|d| d.is_default) {
            *counts.entry((d.host.clone(), d.direction)).or_default() += 1;
        }
        for (key, n) in counts {
            assert!(n <= 1, "more than one default for {key:?}: {n}");
        }
    }
}
