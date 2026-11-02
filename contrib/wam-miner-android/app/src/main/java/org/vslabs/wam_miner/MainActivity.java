package org.vslabs.wam_miner;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
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
            getWindow().getDecorView().setSystemUiVisibility(
                    android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
                            android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            );
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
}
