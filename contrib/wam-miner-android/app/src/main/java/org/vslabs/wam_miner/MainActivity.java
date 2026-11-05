package org.vslabs.wam_miner;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.pm.PackageInfoCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.google.gson.Gson;

import org.vslabs.model.MinerConfigModel;
import org.vslabs.model.PoolObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {

    MinerConfigModel configObject = null;
    List<PoolObject> poolsObject = null;
    String poolString = null, hwinfo = null;
    boolean pool = false, config = false;

    // 1. Initialize background execution tools
    // Executor to run networking code on a separate background thread
    private final ExecutorService executorService = Executors.newSingleThreadExecutor();
    // Handler bound to the main thread loop to safely change UI text
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        findViewById(R.id.getStartedBtn).setEnabled(false);

        hwinfo = getIntent().getStringExtra("HWINFO");
        ((TextView) findViewById(R.id.hwinfo)).setText(hwinfo);

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }

        executorService.execute(new Runnable() {
            @Override
            public void run() {
                // This runs safely in the background (Fixes the NetworkOnMainThreadException)
                final boolean configFound = getConfig();

                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (configFound) {
                            Toast.makeText(MainActivity.this, "Previously saved config found.", Toast.LENGTH_SHORT).show();
                        } else {
                            Toast.makeText(MainActivity.this, "No previously saved config found.", Toast.LENGTH_SHORT).show();
                        }
                        findViewById(R.id.getStartedBtn).setEnabled(true);
                    }
                });
            }
        });

        Button openFormButton = findViewById(R.id.getStartedBtn);

        // Set the click listener to handle navigation
        openFormButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // Create an Intent targeting FormActivity
                Intent intent = new Intent(MainActivity.this, ConfigActivity.class);
                if (configObject != null) intent.putExtra("CONFIG", configObject);
                intent.putExtra("HWINFO", hwinfo);
                finish();
                startActivity(intent);
            }
        });

        // Find the top-right information shortcut icon
        android.widget.ImageButton aboutButton = findViewById(R.id.aboutBtn);
        aboutButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showAboutDialog();
            }
        });


        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.main), (v, insets) -> {
            Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom);
            return insets;
        });
    }

    private boolean getConfig() {
        boolean result = false;
        Gson gson = new Gson();
        File configFile = new File(this.getFilesDir(), "miner_config.json");

        // ATTEMPT TO LOAD LOCAL CACHE FIRST
        if (configFile.exists()) {
            try (BufferedReader reader = new BufferedReader(new FileReader(configFile))) {
                configObject = gson.fromJson(reader, MinerConfigModel.class);
                if (configObject != null) {
                    result = true;
//                    config = true;
                    // If local config exists, mark setup as partially validated
                    // We will still attempt to refresh pool lists via network
                }
            } catch (Exception e) {
                e.printStackTrace();
                System.out.println("Failed to parse local config cache.");
            }
        }
        return result;
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        // Clean up the executor to avoid memory leaks if the activity is destroyed early
        if (!executorService.isShutdown()) {
            executorService.shutdown();
        }
    }

    private void showAboutDialog() {
        android.view.LayoutInflater inflater = android.view.LayoutInflater.from(this);
        android.view.View dialogView = inflater.inflate(R.layout.dialog_about, null);

        // Bind layouts fields from the XML template
        android.widget.ImageButton btnCore = (ImageButton) dialogView.findViewById(R.id.btn_dialog_core);
        android.widget.ImageButton btnGithub = (ImageButton) dialogView.findViewById(R.id.btn_dialog_dev);
        //gvstodo TextView
        android.widget.TextView txtVersion = (TextView) dialogView.findViewById(R.id.txt_dialog_version);
        android.widget.TextView txtBuild = (TextView) dialogView.findViewById(R.id.txt_dialog_build);

        // Link Core System redirect logic
        btnCore.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View v) {
                startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("https://wamcoin.org/"))); // Points to your vslabs server node URL
            }
        });

        // Link GitHub repository redirection logic
        btnGithub.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View v) {
                startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("https://github.com/gvsa/wam-coin/tree/wam-miner-android")));
            }
        });

        // Read app package details dynamically from the manifest build settings
        try {
            android.content.pm.PackageInfo packageInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
            txtVersion.setText(String.valueOf("Version: " + packageInfo.versionCode));

            long code = PackageInfoCompat.getLongVersionCode(packageInfo);

            // Fetch running ABI runtime architecture profile
            String primaryCpuArchitecture = "Unknown";
            if (android.os.Build.SUPPORTED_ABIS != null && android.os.Build.SUPPORTED_ABIS.length > 0) {
                primaryCpuArchitecture = android.os.Build.SUPPORTED_ABIS[0];
            }

            // Combines both parameters into your target "Build Info: --" TextView field
            if (txtBuild != null) {
                String build = "Build Info: " + packageInfo.versionName + " (" + primaryCpuArchitecture + ")";
                txtBuild.setText(build);
            }
        } catch (Exception e) {
            // Explicitly print the error to Logcat under a searchable tag
            android.util.Log.e("WAM_MINER_ERROR", "Failed to load package info", e);
        }

        // Build and display the alert dialog popup overlay
        androidx.appcompat.app.AlertDialog dialog = new androidx.appcompat.app.AlertDialog.Builder(this).setTitle("About WAM Miner").setView(dialogView).setPositiveButton("Close", null).create();

        dialog.show();

        // Forces the window context system overlay layer to lock into the exact physical center
        if (dialog.getWindow() != null) {
            dialog.getWindow().setGravity(android.view.Gravity.CENTER);
        }
    }

}
