package org.vslabs.model;

import java.io.Serializable;

public class MinerConfigModel implements Serializable {
    private static final long serialVersionUID = 1L;
    public String stratum;
    public int port;
    public String address;
    public String name;
    public int cores;
}
