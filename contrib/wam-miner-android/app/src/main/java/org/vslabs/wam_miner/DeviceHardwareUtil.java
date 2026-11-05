package org.vslabs.wam_miner;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;

import java.io.BufferedReader;
import java.io.FileReader;
import java.io.IOException;
import java.util.Locale;

public class DeviceHardwareUtil {

    public static String getDeviceHardwareSpecs(Context context) {
        // 1. Get Processor Architecture
        String architecture = "Unknown";
        if (Build.SUPPORTED_ABIS != null && Build.SUPPORTED_ABIS.length > 0) {
            architecture = Build.SUPPORTED_ABIS[0]; // Returns e.g., "arm64-v8a", "armeabi-v7a", "x86_64"
        }

        // 2. Get Total Installed RAM (Formatted in GB)
        String totalRamStr = "Unknown RAM";
        ActivityManager activityManager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (activityManager != null) {
            ActivityManager.MemoryInfo memoryInfo = new ActivityManager.MemoryInfo();
            activityManager.getMemoryInfo(memoryInfo);

            // Convert bytes to Gigabytes roughly rounding to closest whole number
            double totalBytes = memoryInfo.totalMem;
            double totalGb = totalBytes / (1024.0 * 1024.0 * 1024.0);
            totalRamStr = String.format(Locale.US, "%.1f GB", totalGb);
        }

        // 3. Get Processor Name / Hardware SoC
        String processorName = getProcessorNameFromSystem();

        // Combine everything into a neat summary string
        return "--- Device Hardware Specs ---\n" +
                "Processor Name: " + processorName + "\n" +
                "Architecture:   " + architecture + "\n" +
                "Installed RAM:  " + totalRamStr + "\n" +
                "-----------------------------";
    }

    private static String getProcessorNameFromSystem() {
        // Fallback strategy 1: Check standard Android Build properties (Available natively on many API 30 devices)
        if (Build.VERSION.SDK_INT >= 31) {
            // Android 12+ has Build.SOC_MANUFACTURER / SOC_MODEL
        }

        // Check standard hardware field
        String hardware = Build.HARDWARE;
        if (hardware != null && !hardware.isEmpty() && !hardware.toLowerCase(Locale.ROOT).contains("unknown")) {
            // Checks if it directly matches a platform string (e.g., "qcom" for Qualcomm, "mt6765" for MediaTek)
            if (hardware.length() >= 4) {
                // If it looks like a valid code, read the /proc/cpuinfo fallback below for more detailed user friendly name first
            }
        }

        // Fallback strategy 2: Parse Linux /proc/cpuinfo for the hardware chip field
        try (BufferedReader br = new BufferedReader(new FileReader("/proc/cpuinfo"))) {
            String line;
            while ((line = br.readLine()) != null) {
                // Look for "Hardware" or "Processor" definitions inside kernel allocations
                if (line.startsWith("Hardware") || line.startsWith("HARDWARE")) {
                    String[] parts = line.split(":");
                    if (parts.length > 1) {
                        return parts[1].trim(); // Returns strings like "Qualcomm Technologies, Inc SM8150"
                    }
                }
            }
        } catch (IOException e) {
            e.printStackTrace();
        }

        // Fallback strategy 3: Use the system board property if file-read access is locked down by permissions
        return (Build.BOARD != null) ? Build.BOARD : Build.HARDWARE;
    }

}
