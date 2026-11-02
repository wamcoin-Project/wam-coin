package org.vslabs.wam_miner;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
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
import com.google.gson.reflect.TypeToken;

import org.vslabs.model.MinerConfigModel;
import org.vslabs.model.PoolObject;

import java.io.InputStreamReader;
import java.lang.reflect.Type;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;

public class MainActivity extends AppCompatActivity {

    MinerConfigModel configObject = null;
    String device_id = null;
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

        device_id = Settings.Secure.getString(this.getContentResolver(), Settings.Secure.ANDROID_ID);

        findViewById(R.id.getStartedBtn).setEnabled(false);

        hwinfo = getIntent().getStringExtra("HWINFO");
        ((TextView) findViewById(R.id.hwinfo)).setText(device_id + "\n" + hwinfo);
//        Toast.makeText(MainActivity.this, "hwinfo loaded", Toast.LENGTH_LONG).show();

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }

        // 2. Push the network call to a background thread
        executorService.execute(new Runnable() {
            @Override
            public void run() {
                // This runs safely in the background (Fixes the NetworkOnMainThreadException)
                final boolean isSuccess = getPoolAndConfig();

                // 3. Jump back to the Main/UI thread to update the app interface
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (isSuccess) {
                            // SUCCESS: Update your UI components or launch the main app screen
                            // Example: updateMinerStatusText("Connected to pool!");
                            findViewById(R.id.getStartedBtn).setEnabled(true);
                        } else {
                            // FAILURE: Show an error message to the user
                            // Example: Toast.makeText(MainActivity.this, "Network error", Toast.LENGTH_LONG).show();
                            Toast.makeText(MainActivity.this, "Network error! Recheck Internet and start the app again!", Toast.LENGTH_LONG).show();
                        }
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
                if (poolString != null) intent.putExtra("POOLS", poolString);
                intent.putExtra("DEVICE_ID", device_id);
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

    private void doinit() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
            }
        });

    }

    private boolean getPoolAndConfig() {
        Gson gson = new Gson();
        try {
            // ==========================================
            // REQUEST 1: GET POOLS
            // ==========================================
            URL url1 = new URL("https://wamnode.vslabs.co.in/api/getpools");
            HttpsURLConnection poolCon = (HttpsURLConnection) url1.openConnection();

            poolCon.setRequestMethod("GET");
            poolCon.setRequestProperty("Accept", "application/json");

            if (poolCon.getResponseCode() == 200) {
                try (InputStreamReader in = new InputStreamReader(poolCon.getInputStream(), StandardCharsets.UTF_8)) {

                    Type type = new TypeToken<List<PoolObject>>() {
                    }.getType();

                    // 2. Parse the network input stream directly into a List
                    poolsObject = gson.fromJson(in, type);

                    if (poolsObject != null && !poolsObject.isEmpty()) {
                        // 3. Convert the List cleanly into a JSON string
                        poolString = gson.toJson(poolsObject, type);
                    }
                    pool = true;
                }
            } else {
                System.out.println("Pools API Failed: " + poolCon.getResponseCode());
                poolCon.disconnect();
                pool = false;
            }
            poolCon.disconnect();

            // ==========================================
            // REQUEST 2: GET MINER CONFIG
            // ==========================================
            URL url2 = new URL("https://wamnode.vslabs.co.in/api/getminerconfig");
            HttpsURLConnection configCon = (HttpsURLConnection) url2.openConnection();

            configCon.setRequestMethod("POST");
            configCon.setRequestProperty("Accept", "application/json");
            configCon.setRequestProperty("Content-Type", "application/json; utf-8");
            configCon.setDoOutput(true);

            String jsonPayload = "{\"id\":\"" + device_id + "\"}";
            try (java.io.OutputStream os = configCon.getOutputStream()) {
                byte[] input = jsonPayload.getBytes(StandardCharsets.UTF_8);
                os.write(input, 0, input.length);
            }

            if (configCon.getResponseCode() == 200) {
                try (InputStreamReader in = new InputStreamReader(configCon.getInputStream(), StandardCharsets.UTF_8)) {
                    configObject = gson.fromJson(in, MinerConfigModel.class);
                    config = (configObject != null);
                }
            } else {
                System.out.println("Miner Config API Failed: " + configCon.getResponseCode());
                config = false;
            }
            configCon.disconnect();

        } catch (Exception e) {
            e.printStackTrace();
            config = false;
        }
        return (pool);
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
