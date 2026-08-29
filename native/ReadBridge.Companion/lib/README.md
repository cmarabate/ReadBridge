# Vendored Dependency: Interop.UIAutomationClient.dll

## Overview
This directory contains the Primary Interop Assembly (PIA) `Interop.UIAutomationClient.dll` generated from the Windows 10 SDK (`UIAutomationCore.idl` / `UIAutomationClient.tlb`).

## Provenance & Metadata
* **Package ID**: `Interop.UIAutomationClient`
* **Version**: `10.19041.0`
* **Author / Maintainer**: Roman Roemer ([FlaUI Project](https://github.com/FlaUI/FlaUI))
* **Repository**: [https://github.com/FlaUI/UIAutomation-Interop](https://github.com/FlaUI/UIAutomation-Interop)
* **NuGet Reference**: [https://www.nuget.org/packages/Interop.UIAutomationClient/10.19041.0](https://www.nuget.org/packages/Interop.UIAutomationClient/10.19041.0)
* **License**: MIT ([SPDX: MIT](https://licenses.nuget.org/MIT))
* **Target Architecture**: AnyCPU (MSIL interop wrapper)
* **Target Framework**: `netcoreapp3.0` / `netstandard2.0`
* **File Size**: 151,040 bytes
* **SHA256 Checksum**: `DCEA43A1F5A2114B7BCC9E41CC1377064307611D0CAA50F1EC203B887F4C20BB`

## Technical Rationale for Vendoring in Feasibility Slice
In modern SDK-style projects (`net10.0-windows`), referencing the NuGet package via standard `<PackageReference>` without custom `.props`/`.targets` causes MSBuild to resolve the assembly as a normal managed reference (`EmbedInteropTypes=false`), which prevents direct instantiation of COM coclasses like `new CUIAutomation8()` (emitting `CS0246` / `CS1752`).

By declaring:
```xml
<ItemGroup>
  <Reference Include="Interop.UIAutomationClient">
    <HintPath>lib\Interop.UIAutomationClient.dll</HintPath>
    <Private>true</Private>
  </Reference>
</ItemGroup>
```
MSBuild directly resolves all `IUIAutomation8`, `IUIAutomationTextPattern`, `IUIAutomationTextPattern2`, and `IUIAutomationTextRange` COM vtables cleanly and deterministically across all development machines.
