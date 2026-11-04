package org.vslabs.wam_miner;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.Log;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import com.google.gson.Gson;

import org.vslabs.model.MinerConfigModel;

import java.io.File;
import java.io.FileWriter;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class ConfigActivity extends AppCompatActivity {

    MinerConfigModel configObject = null;
    private final int coreMax = Runtime.getRuntime().availableProcessors();
    private EditText input_stratum = null, input_port = null, input_address = null, input_worker = null;
    TextView input_cores = null;
    private TextView errorAddress, errorStratum, errorPort, errorWorker;


    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_config);

        input_stratum = (EditText) findViewById(R.id.input_stratum);
        input_port = (EditText) findViewById(R.id.input_port);
        input_address = (EditText) findViewById(R.id.input_address);
        input_worker = (EditText) findViewById(R.id.input_worker);
        input_cores = (TextView) findViewById(R.id.input_cores);

        errorAddress = findViewById(R.id.error_address);
        errorStratum = findViewById(R.id.error_stratum);
        errorPort = findViewById(R.id.error_port);
        errorWorker = findViewById(R.id.error_worker);

        setupErrorClearer(input_stratum, errorStratum);
        setupErrorClearer(input_port, errorPort);
        setupErrorClearer(input_address, errorAddress);
        setupErrorClearer(input_worker, errorWorker);

        String hwinfo = this.getIntent().getStringExtra("HWINFO");

        ((TextView) findViewById(R.id.config_hwinfo)).setText("Current Hardware Information:\n" + hwinfo);

        configObject = (MinerConfigModel) this.getIntent().getSerializableExtra("CONFIG");
        if (configObject != null) {
            input_stratum.setText(configObject.stratum);
            input_port.setText(String.valueOf(configObject.port));
            input_address.setText(configObject.address);
            input_worker.setText(configObject.name);
            input_cores.setText(String.valueOf(configObject.cores));
        }

        // Add the text change listener
        input_cores.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
                // Triggered right BEFORE the text changes
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                // Triggered WHILE the text is changing
//                Log.d("TextDebug", "Text changed to: " + s.toString());

                // Execute your custom action logic here!
                int cur = Integer.parseInt(input_cores.getText().toString().trim());

                if (cur == coreMax) {
                    findViewById(R.id.coreplus).setEnabled(false);
                } else if (cur == 1) {
                    findViewById(R.id.coreminus).setEnabled(false);
                } else if (cur > 1 && cur < coreMax) {
                    findViewById(R.id.coreplus).setEnabled(true);
                    findViewById(R.id.coreminus).setEnabled(true);
                }
            }

            @Override
            public void afterTextChanged(Editable s) {
                // Triggered right AFTER the text has completely changed
            }
        });

        findViewById(R.id.coreplus).setOnClickListener(view -> {
            int cur = Integer.parseInt(input_cores.getText().toString().trim());
            if (cur < coreMax) {
                cur++;
                input_cores.setText(String.valueOf(cur));
            }
        });

        findViewById(R.id.coreminus).setOnClickListener(view -> {
            int cur = Integer.parseInt(input_cores.getText().toString().trim());
            if (cur > 1) {
                cur--;
                input_cores.setText(String.valueOf(cur));
            }
        });


        ExecutorService executor = Executors.newSingleThreadExecutor();
        Handler uiHandler = new Handler(Looper.getMainLooper());

        findViewById(R.id.saveConfigBtn).setOnClickListener(view -> {

            //validate configs and show error info
            if (input_address.getText().toString().isBlank()) {
//                Toast.makeText(ConfigActivity.this, "Please provide valid wallet address!", Toast.LENGTH_LONG).show();
                errorAddress.setText("Please provide valid wallet address!");
                errorAddress.setVisibility(TextView.VISIBLE);
            } else if (input_stratum.getText().toString().isBlank()) {
//                Toast.makeText(ConfigActivity.this, "Stratum URL cannot be blank", Toast.LENGTH_LONG).show();
                errorStratum.setText("Stratum URL cannot be blank");
                errorStratum.setVisibility(TextView.VISIBLE);
            } else if (input_port.getText().toString().isBlank()) {
//                Toast.makeText(ConfigActivity.this, "port cannot be blank", Toast.LENGTH_LONG).show();
                errorPort.setText("port cannot be blank!");
                errorPort.setVisibility(TextView.VISIBLE);
            } else {
                // 1. Gather all data inputs securely on the Main UI Thread first
                String inputStratum = String.valueOf(((EditText) findViewById(R.id.input_stratum)).getText());
                int inputPort = Integer.parseInt(String.valueOf(((EditText) findViewById(R.id.input_port)).getText()));
                String inputAddress = String.valueOf(((EditText) findViewById(R.id.input_address)).getText());
                String inputWorker = String.valueOf(((EditText) findViewById(R.id.input_worker)).getText());
                int inputCores = Integer.parseInt(String.valueOf(((TextView) findViewById(R.id.input_cores)).getText()).trim());

                // 2. Offload network processing layers completely to the background thread pool
                executor.execute(() -> {
                    MinerConfigModel pendingConfig = new MinerConfigModel();
                    pendingConfig.stratum = inputStratum;
                    pendingConfig.port = inputPort;
                    pendingConfig.address = inputAddress;
                    pendingConfig.name = inputWorker;
                    pendingConfig.cores = inputCores;

                    Gson gson = new Gson();

                    boolean saved = false;
                    File configFile = new File(ConfigActivity.this.getFilesDir(), "miner_config.json");
                    try (FileWriter writer = new FileWriter(configFile)) {
                        gson.toJson(pendingConfig, writer);
                        saved = true;
                        Log.d("gvsdebug", "Config successfully serialized and saved to internal storage.");
                    } catch (Exception fileException) {
                        fileException.printStackTrace();
                        Log.e("gvsdebug", "Failed to cache config locally.", fileException);
                    }

                    // 6. Return layout component adjustments safely back onto the Main UI Thread context loop
                    boolean finalSaved = saved;
                    uiHandler.post(() -> {
                        if (finalSaved) {
                            configObject = pendingConfig;
                            Toast.makeText(ConfigActivity.this, "Config saved to local device (will auto-reload on next restart)", Toast.LENGTH_LONG).show();
                        } else {
                            Toast.makeText(ConfigActivity.this, "Config not saved to local device !!!", Toast.LENGTH_LONG).show();
                        }
                    });

                });
            }
        });

        findViewById(R.id.startnativemining).
                setOnClickListener(view ->
                {
                    if (configObject == null) return;

                    // 1. Kick off the background high-priority Native Foreground Service tree pass
                    Intent serviceIntent = new Intent(ConfigActivity.this, MinerNativeService.class);
                    if (configObject.name != null && !configObject.name.isEmpty())
                        configObject.address = configObject.address + "." + configObject.name;
                    serviceIntent.setAction(MinerNativeService.ACTION_START_NATIVE);
                    serviceIntent.putExtra("CONFIG", configObject);

                    startForegroundService(serviceIntent);

                    // 2. Open the newly added dedicated Logs Terminal canvas view instantly
                    Intent logsIntent = new Intent(ConfigActivity.this, LogsActivity.class);
                    startActivity(logsIntent);
                });

    }

    private void setupErrorClearer(EditText editText, final TextView errorView) {
        editText.addTextChangedListener(new android.text.TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                // As soon as the user changes anything, clear the text and hide the view
                errorView.setText("");
                errorView.setVisibility(View.GONE);
            }

            @Override
            public void afterTextChanged(android.text.Editable s) {
            }
        });
    }
}
